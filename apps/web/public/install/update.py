#!/usr/bin/env python3
"""Host-side updater for installer-managed Compose deployments."""

import copy
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class LocalOnly(HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        raise HTTPError(req.full_url, code, msg, headers, fp)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


# Readiness must inspect this local backend, without proxy routing or redirects.
urlopen = build_opener(ProxyHandler({}), LocalOnly()).open


class UpdateError(Exception):
    """An actionable failure whose message contains no deployment secrets."""


class UpdateTimeout(UpdateError):
    """The runtime may still have an operation running after its client exits."""


def run(command, cwd, label, env=None):
    print(label, flush=True)
    try:
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        raise UpdateTimeout(f'{label} exceeded the 10 minute execution limit. The container operation may still be running.') from None
    if result.returncode:
        raise UpdateError(f"{label} failed. Configuration output is withheld because it may contain secrets.")
    return result.stdout


def read_json(value, label):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        raise UpdateError(f"{label} did not return valid JSON.") from None


class Updater:
    def __init__(self, directory, target, stage, compose):
        self.directory = Path(directory).resolve()
        self.target = Path(target).resolve()
        self.stage = Path(stage).resolve()
        self.compose = compose
        self.env_path = self.directory / '.env'
        self.backup = None
        self.web_interrupted = False
        self.startup_timeout = 180

    def dc(self, arguments, label, compose=None):
        return run((compose or self.compose) + arguments, self.directory, label)

    def config(self, compose=None, raw=False):
        arguments = ['config', '--format', 'json']
        if raw:
            # Compose 2.38 resolves env_file despite --no-env-resolution unless
            # interpolation is disabled too. Only literal installer paths qualify.
            arguments.extend(['--no-env-resolution', '--no-interpolate'])
        return read_json(self.dc(arguments, 'Compose configuration inspection (requires JSON and --no-env-resolution support)', compose), 'Compose configuration')

    def policy(self, compose=None):
        value = read_json(self.dc([
            'run', '--rm', '--no-deps', '--entrypoint', 'node', 'web',
            '/app/packages/cli/dist/index.js', 'access', 'origins',
        ], 'Access origin inspection', compose), 'Access origin inspection')
        if not isinstance(value, dict) or not isinstance(value.get('origin'), str) or not isinstance(value.get('passwordOrigins'), list):
            raise UpdateError('Access origin inspection returned an unsupported policy.')
        if not isinstance(value.get('hasOwner'), bool) or not isinstance(value.get('canonicalConfigured'), bool):
            raise UpdateError('Access origin inspection returned incomplete owner information.')
        return value

    def topology(self, config, raw):
        try:
            services = config['services']
            web = services['web']
            environment = web.get('environment', {})
            ports = web['ports']
            files = raw['services']['web']['env_file']
            paths = [entry['path'] if isinstance(entry, dict) else entry for entry in files]
            port = ports[0]
            published = str(port['published'])
            bind = port.get('host_ip', '0.0.0.0')
            valid = (
                'db' in services and 'redis' in services
                and str(environment.get('SELF_HOSTED', '')).lower() == 'true'
                and len(ports) == 1 and int(port['target']) == 3003
                and port.get('protocol', 'tcp') == 'tcp'
                and re.fullmatch(r'[1-9][0-9]{0,4}', published)
                and int(published) <= 65535
                and bind in ('0.0.0.0', '127.0.0.1', '::1', '::')
                and len(paths) == 1
                and (self.directory / paths[0]).resolve() == self.env_path
            )
        except (KeyError, TypeError, ValueError, IndexError, AttributeError):
            valid = False
        if not valid:
            raise UpdateError('Unsupported Compose topology. Update requires installer-managed web/db/redis, one web port, and the installed .env file. Configure custom deployments manually.')
        return int(published), bind, environment

    def migrate(self, config, policy, port, bind, environment, temporary):
        original = self.env_path.read_bytes()
        keys = set(re.findall(rb'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', original, re.M))
        explicit = any(key in environment or key.encode() in keys for key in ('APP_URL', 'SIDEDOOR_PASSWORD_ORIGINS'))
        if explicit or policy['canonicalConfigured']:
            return policy, []
        derived_env = dict(os.environ, HOST_PORT=str(port), INSTALL_BIND_ADDRESS=bind,
                           OS='macos' if sys.platform == 'darwin' else 'linux')
        aliases = read_json(run(['bash', '-eu', '-c',
            'source "$1"; derive_install_origins; printf "%s" "$INSTALL_PASSWORD_ORIGINS"',
            'update-origins', str(self.stage / 'network.sh')], self.directory,
            'Installer origin discovery', derived_env), 'Installer origin discovery')
        canonical = f'http://localhost:{port}'
        candidate = temporary / 'candidate.env'
        suffix = f'APP_URL={canonical}\nSIDEDOOR_PASSWORD_ORIGINS={json.dumps(aliases, separators=(",", ":"))}\n'.encode()
        candidate.write_bytes(original + (b'\n' if original and not original.endswith(b'\n') else b'') + suffix)
        candidate.chmod(0o600)
        overlay = temporary / 'candidate.json'
        overlay.write_text(json.dumps({'services': {'web': {'env_file': [str(candidate)]}}}))
        overlay.chmod(0o600)
        command = self.compose + ['--env-file', str(candidate), '-f', str(overlay)]
        proposed = self.config(command)
        expected = copy.deepcopy(config)
        expected['services']['web'].setdefault('environment', {}).update({
            'APP_URL': canonical, 'SIDEDOOR_PASSWORD_ORIGINS': json.dumps(aliases, separators=(',', ':')),
        })
        if proposed != expected:
            raise UpdateError('Candidate origins changed unrelated Compose configuration. No configuration was saved.')
        validated = self.policy(command)
        if validated['origin'] != canonical or set(validated['passwordOrigins']) != set(aliases) - {canonical}:
            raise UpdateError('Candidate origin policy did not match the installer addresses.')
        if self.env_path.is_symlink() or self.env_path.read_bytes() != original:
            raise UpdateError('Installed configuration changed during update. Retry after other configuration work finishes.')
        fd, backup = tempfile.mkstemp(prefix='.env.before-update-', dir=self.directory)
        self.backup = Path(backup)
        with os.fdopen(fd, 'wb') as output:
            output.write(original)
            output.flush()
            os.fsync(output.fileno())
        candidate.chmod(stat.S_IMODE(self.env_path.stat().st_mode))
        with candidate.open('rb') as source:
            os.fsync(source.fileno())
        os.replace(candidate, self.env_path)
        print(f'Installed missing login origins. Configuration backup: {self.backup}')
        return validated, aliases

    def install_cli(self):
        for source, destination in (
            ('flight-finder-cli-flags.sh', self.target.parent / 'flight-finder-cli-flags.sh'),
            ('flight-finder-cli', self.target),
        ):
            staged = self.stage / source
            staged.chmod(0o755 if source == 'flight-finder-cli' else 0o644)
            os.replace(staged, destination)

    def readiness(self, port, bind, policy, migrated):
        host = '[::1]' if bind == '::1' else '127.0.0.1'
        backend = f'http://{host}:{port}'
        deadline = time.monotonic() + self.startup_timeout
        while True:
            try:
                with urlopen(backend + '/api/health', timeout=2) as response:
                    health = json.load(response)
                if isinstance(health, dict) and health.get('status') == 'ok' and health.get('database') == 'connected' and health.get('redis') == 'connected':
                    break
            except (URLError, TimeoutError, ValueError, OSError):
                pass
            if time.monotonic() >= deadline:
                raise UpdateError("Updated application did not become healthy. Run 'flight-finder logs'.")
            time.sleep(1)
        for origin in dict.fromkeys([policy['origin']] + migrated):
            parsed = urlsplit(origin)
            request = Request(backend + '/api/access/check-origin', data=b'{}', headers={
                'Content-Type': 'application/json', 'Origin': origin, 'Host': parsed.netloc,
                'X-Sidedoor-Origin': origin, 'X-Forwarded-Proto': parsed.scheme,
            })
            try:
                with urlopen(request, timeout=10) as response:
                    if response.status != 200 or json.load(response) != {'ok': True}:
                        raise UpdateError('Updated application rejected the configured login origin.')
            except (URLError, TimeoutError, OSError, ValueError):
                raise UpdateError('Updated application rejected the configured login origin. Check access configuration and logs.') from None
        if not policy['hasOwner']:
            raise UpdateError("Owner setup is required. Run 'flight-finder access setup' before signing in.")

    def execute(self):
        timeout = os.environ.get('FLIGHT_FINDER_STARTUP_TIMEOUT', '180')
        if not re.fullmatch(r'[1-9][0-9]{0,4}', timeout):
            raise UpdateError('FLIGHT_FINDER_STARTUP_TIMEOUT must be a positive number of seconds.')
        self.startup_timeout = int(timeout)
        if self.env_path.is_symlink() or not self.env_path.is_file():
            raise UpdateError('The installed .env must be a regular file, not a symlink.')
        lock = self.directory / '.flight-finder-update.lock'
        try:
            lock.mkdir(mode=0o700)
        except FileExistsError:
            raise UpdateError(f'Another update holds {lock}. Verify that no updater or preparation container is running before removing this empty lock directory.') from None
        retain_lock = False
        try:
            config, raw = self.config(), self.config(raw=True)
            port, bind, environment = self.topology(config, raw)
            self.install_cli()
            self.dc(['pull', 'web'], 'Image pull')
            self.dc(['up', '-d', '--no-recreate', 'db', 'redis'], 'Database and Redis startup')
            policy = self.policy()
            with tempfile.TemporaryDirectory(prefix='.flight-finder-config-', dir=self.directory) as temporary:
                policy, migrated = self.migrate(config, policy, port, bind, environment, Path(temporary))
            self.web_interrupted = True
            self.dc(['stop', 'web'], 'Web stop')
            self.dc(['run', '--rm', '--no-deps', '-e', 'SIDEDOOR_PREPARE_ONLY=true', 'web'], 'Database and access preparation')
            self.dc(['up', '-d', '--force-recreate', '--no-deps', 'web'], 'Web recreation')
            self.readiness(port, bind, policy, migrated)
            self.web_interrupted = False
            print(f"Updated and verified backend login policy for {policy['origin']}. External DNS, TLS, and proxy routing require separate verification.")
        except (UpdateTimeout, KeyboardInterrupt):
            retain_lock = True
            print(f'Update lock retained at {lock}. Do not retry until the outstanding container operation has stopped. Inspect the runtime, then remove this empty lock directory.', file=sys.stderr)
            raise
        finally:
            if not retain_lock:
                lock.rmdir()


def main():
    if len(sys.argv) < 5:
        print('Invoke this updater through flight-finder update.', file=sys.stderr)
        return 1
    directory, target, stage, *compose = sys.argv[1:]
    updater = Updater(directory, target, stage, compose)
    if updater.stage.parent != updater.target.parent or not updater.stage.name.startswith('.flight-finder-update.'):
        print('Invalid updater staging directory.', file=sys.stderr)
        return 1
    try:
        updater.execute()
        return 0
    except (UpdateError, OSError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, UpdateError) else 'Update interrupted.' if isinstance(error, KeyboardInterrupt) else 'Host filesystem or process operation failed. Check permissions and free disk space.'
        print(f'Update failed: {message}', file=sys.stderr)
        if updater.web_interrupted:
            print("Web serving may be interrupted. Run 'flight-finder logs', fix the reported preparation or startup failure, then retry 'flight-finder update'. Do not roll back the image without checking schema compatibility.", file=sys.stderr)
        if updater.backup:
            print(f'Configuration backup retained at {updater.backup}. No automatic database rollback was attempted.', file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(updater.stage)


if __name__ == '__main__':
    sys.exit(main())
