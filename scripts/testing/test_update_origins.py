"""Exercise the shipped updater with container and HTTP system boundaries."""

import copy
import importlib.util
import io
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'apps/web/public'
SPEC = importlib.util.spec_from_file_location('flight_finder_update', PUBLIC / 'install/update.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response(io.BytesIO):
    status = 200


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='flight-finder-update-test-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.stage = self.directory / '.flight-finder-update.test'
        self.stage.mkdir(mode=0o700)
        for source in ['flight-finder-cli', 'flight-finder-cli-flags.sh', 'install/network.sh', 'install/update.py']:
            shutil.copyfile(PUBLIC / source, self.stage / Path(source).name)
        self.env = self.directory / '.env'
        self.original = b'# preserved\nHOST_PORT=9999\nSECRET=do-not-print-this\n'
        self.env.write_bytes(self.original)
        self.env.chmod(0o640)
        self.config = {'name': 'existing-project', 'services': {
            'web': {'environment': {'SELF_HOSTED': 'true', 'SECRET': 'do-not-print-this'},
                    'ports': [{'target': 3003, 'published': '3098', 'host_ip': '127.0.0.1'}]},
            'db': {'image': 'postgres:16'}, 'redis': {'image': 'redis:7'},
        }}
        self.policy = {'origin': 'http://localhost:3003', 'passwordOrigins': [],
                       'hasOwner': True, 'canonicalConfigured': False}
        self.commands = []
        self.requests = []
        self.failure = None
        self.bad_config = False
        self.bad_json = False
        self.custom_env = False
        self.reject_origin = False
        self.updater = MODULE.Updater(str(self.directory), str(self.directory / 'flight-finder'),
                                      str(self.stage), ['docker', 'compose', '-f', 'docker-compose.yml',
                                                        '-f', 'docker-compose.override.yml', '-f', 'docker-compose.vpn.yml'])
        self.real_run = subprocess.run

    def process(self, command, **kwargs):
        if command[0] == 'bash':
            return self.real_run(command, **kwargs)
        self.commands.append(command)
        candidate = '--env-file' in command
        result = copy.deepcopy(self.config)
        policy = copy.deepcopy(self.policy)
        if candidate:
            candidate_path = Path(command[command.index('--env-file') + 1])
            values = dict(line.split('=', 1) for line in candidate_path.read_text().splitlines()
                          if line.startswith(('APP_URL=', 'SIDEDOOR_PASSWORD_ORIGINS=')))
            result['services']['web']['environment'].update(values)
            policy.update(origin=values['APP_URL'], canonicalConfigured=True,
                          passwordOrigins=[value for value in json.loads(values['SIDEDOOR_PASSWORD_ORIGINS'])
                                           if value != values['APP_URL']])
            if self.bad_config:
                result['services']['db']['image'] = 'unexpected'
        # Compose 2.38.2 drops env_file unless both switches are present.
        if '--no-env-resolution' in command and '--no-interpolate' in command:
            result['services']['web']['env_file'] = [{'path': str(self.directory / 'custom.env' if self.custom_env else self.env), 'required': True}]
        if self.failure and self.failure in command:
            return subprocess.CompletedProcess(command, 1, '', 'do-not-print-this')
        value = policy if 'origins' in command else result
        return subprocess.CompletedProcess(command, 0, 'broken' if self.bad_json else json.dumps(value), '')

    def http(self, request, **kwargs):
        if isinstance(request, str):
            return Response(json.dumps({'status': 'ok', 'database': 'connected', 'redis': 'connected'}).encode())
        self.requests.append(request)
        self.assertEqual(request.get_header('Origin'), request.get_header('X-sidedoor-origin'))
        if self.reject_origin:
            raise MODULE.URLError('forbidden')
        return Response(b'{"ok":true}')

    def execute(self):
        output = io.StringIO()
        with patch.object(subprocess, 'run', side_effect=self.process), patch.object(MODULE, 'urlopen', side_effect=self.http), patch('sys.stdout', output):
            self.updater.execute()
        return output.getvalue()

    def test_missing_origins_use_published_port_and_preserve_configuration(self):
        output = self.execute()
        contents = self.env.read_bytes()
        self.assertTrue(contents.startswith(self.original))
        self.assertIn(b'APP_URL=http://localhost:3098\n', contents)
        self.assertNotIn(b'localhost:9999', contents)
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.updater.backup.read_bytes(), self.original)
        self.assertEqual(self.updater.backup.stat().st_mode & 0o777, 0o600)
        self.assertIn('Updated and verified', output)
        self.assertNotIn('do-not-print-this', output)
        self.assertEqual({request.get_header('Origin') for request in self.requests}, {
            'http://localhost:3098', 'http://127.0.0.1:3098', 'http://[::1]:3098',
        })
        self.assertTrue(all('docker-compose.override.yml' in cmd and 'docker-compose.vpn.yml' in cmd for cmd in self.commands))
        self.assertTrue(any(cmd[-5:] == ['up', '-d', '--force-recreate', '--no-deps', 'web'] for cmd in self.commands))

    def test_explicit_environment_and_database_policies_are_never_overwritten(self):
        for key, value in [('APP_URL', 'https://finder.example'), ('APP_URL', ''),
                           ('SIDEDOOR_PASSWORD_ORIGINS', '[]'), ('database', 'https://finder.example')]:
            with self.subTest(key=key, value=value):
                self.setUp()
                if key == 'database':
                    self.policy.update(origin=value, canonicalConfigured=True)
                else:
                    self.config['services']['web']['environment'][key] = value
                self.execute()
                self.assertEqual(self.env.read_bytes(), self.original)
                self.assertIsNone(self.updater.backup)

    def test_saved_explicit_empty_aliases_are_preserved_even_when_not_in_container(self):
        self.env.write_bytes(self.original + b'SIDEDOOR_PASSWORD_ORIGINS=[]\n')
        self.execute()
        self.assertEqual(self.env.read_bytes(), self.original + b'SIDEDOOR_PASSWORD_ORIGINS=[]\n')

    def test_candidate_changes_to_other_services_abort_without_stopping_web(self):
        self.bad_config = True
        with self.assertRaisesRegex(MODULE.UpdateError, 'unrelated Compose'):
            self.execute()
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertFalse(any('stop' in cmd for cmd in self.commands))

    def test_unsupported_compose_and_invalid_topologies_leave_services_untouched(self):
        for failure in ['--no-env-resolution', 'port', 'json']:
            with self.subTest(failure=failure):
                self.setUp()
                self.failure = failure if failure.startswith('--') else None
                self.bad_json = failure == 'json'
                if failure == 'port':
                    self.config['services']['web']['ports'][0]['published'] = '3000-4000'
                with self.assertRaises(MODULE.UpdateError):
                    self.execute()
                self.assertFalse(any('pull' in cmd or 'stop' in cmd or 'up' in cmd for cmd in self.commands))
                self.assertEqual(self.env.read_bytes(), self.original)

    def test_failed_pull_does_not_stop_web_or_fall_back_to_building(self):
        self.failure = 'pull'
        with self.assertRaisesRegex(MODULE.UpdateError, 'Image pull'):
            self.execute()
        self.assertFalse(any('stop' in cmd or 'build' in cmd for cmd in self.commands))
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_custom_environment_file_is_rejected_before_replacing_the_cli(self):
        self.custom_env = True
        with self.assertRaisesRegex(MODULE.UpdateError, 'Unsupported Compose topology'):
            self.execute()
        self.assertTrue((self.stage / 'flight-finder-cli').is_file())
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertFalse(any('pull' in cmd or 'stop' in cmd for cmd in self.commands))

    def test_web_recreation_failure_cannot_report_readiness(self):
        self.failure = '--force-recreate'
        with self.assertRaisesRegex(MODULE.UpdateError, 'Web recreation'):
            self.execute()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.updater.backup.read_bytes(), self.original)

    def test_failed_preparation_preserves_recoverable_configuration_backup(self):
        self.failure = 'SIDEDOOR_PREPARE_ONLY=true'
        with self.assertRaisesRegex(MODULE.UpdateError, 'preparation'):
            self.execute()
        self.assertEqual(self.updater.backup.read_bytes(), self.original)
        self.assertFalse(any('--force-recreate' in cmd for cmd in self.commands))

    def test_disallowed_login_and_missing_owner_are_failures(self):
        for failure in ['origin', 'owner']:
            with self.subTest(failure=failure):
                self.setUp()
                self.reject_origin = failure == 'origin'
                self.policy['hasOwner'] = failure != 'owner'
                with self.assertRaisesRegex(MODULE.UpdateError, 'login origin|Owner setup'):
                    self.execute()

    def test_concurrent_update_and_symlink_configuration_fail_before_container_access(self):
        lock = self.directory / '.flight-finder-update.lock'
        lock.mkdir()
        with self.assertRaisesRegex(MODULE.UpdateError, 'Another update'):
            self.execute()
        self.assertTrue(lock.exists())
        lock.rmdir()
        self.env.unlink()
        self.env.symlink_to(self.stage / 'network.sh')
        with self.assertRaisesRegex(MODULE.UpdateError, 'symlink'):
            self.execute()
        self.assertEqual(self.commands, [])

    def test_invalid_startup_timeout_fails_before_any_mutation(self):
        with patch.dict(os.environ, {'FLIGHT_FINDER_STARTUP_TIMEOUT': 'invalid'}):
            with self.assertRaisesRegex(MODULE.UpdateError, 'positive number'):
                self.execute()
        self.assertEqual(self.commands, [])
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_container_timeout_is_sanitized_and_blocks_overlapping_retries(self):
        with patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('secret-command', 600)):
            with self.assertRaisesRegex(MODULE.UpdateError, 'execution limit') as raised:
                self.updater.execute()
        self.assertNotIn('secret-command', str(raised.exception))
        self.assertTrue((self.directory / '.flight-finder-update.lock').exists())
        with self.assertRaisesRegex(MODULE.UpdateError, 'Another update'):
            self.execute()

    def test_non_object_health_is_unhealthy_and_does_not_report_success(self):
        with patch.object(subprocess, 'run', side_effect=self.process), patch.object(MODULE, 'urlopen', return_value=Response(b'[]')), patch.object(MODULE.time, 'monotonic', side_effect=[0, 999]):
            with self.assertRaisesRegex(MODULE.UpdateError, 'did not become healthy'):
                self.updater.execute()

    def test_timed_out_preparation_retains_backup_and_blocks_a_second_migration(self):
        def container(command, **kwargs):
            if 'SIDEDOOR_PREPARE_ONLY=true' in command:
                raise subprocess.TimeoutExpired(command, 600)
            return self.process(command, **kwargs)

        with patch.object(subprocess, 'run', side_effect=container):
            with self.assertRaisesRegex(MODULE.UpdateTimeout, 'preparation'):
                self.updater.execute()
        self.assertEqual(self.updater.backup.read_bytes(), self.original)
        self.assertTrue((self.directory / '.flight-finder-update.lock').exists())
        self.assertFalse(any('--force-recreate' in cmd for cmd in self.commands))
        with self.assertRaisesRegex(MODULE.UpdateError, 'Another update'):
            self.execute()

    def test_interrupted_operation_keeps_the_lock_until_operator_inspection(self):
        with patch.object(subprocess, 'run', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.updater.execute()
        self.assertTrue((self.directory / '.flight-finder-update.lock').exists())

    def test_origin_readiness_never_follows_http_redirects(self):
        requests = []

        class Backend(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ok","database":"connected","redis":"connected"}')

            def do_POST(self):
                requests.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/unexpected-redirect')
                self.end_headers()

        with HTTPServer(('127.0.0.1', 0), Backend) as server:
            self.config['services']['web']['ports'][0]['published'] = str(server.server_port)
            thread = Thread(target=server.serve_forever)
            thread.start()
            try:
                with patch.object(subprocess, 'run', side_effect=self.process):
                    with self.assertRaisesRegex(MODULE.UpdateError, 'login origin'):
                        self.updater.execute()
            finally:
                server.shutdown()
                thread.join()
        self.assertIn('/api/access/check-origin', requests)
        self.assertNotIn('/unexpected-redirect', requests)


if __name__ == '__main__':
    unittest.main()
