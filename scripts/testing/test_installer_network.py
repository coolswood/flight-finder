"""Run the shipped installer network logic against OS and Docker boundaries."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'apps/web/public/install/network.sh'


class InstallerNetworkTests(unittest.TestCase):
    def configure(self, saved='', port='3003', binding='', occupied='', installed=''):
        with tempfile.TemporaryDirectory(prefix='flight-finder-network-') as temporary:
            directory = Path(temporary)
            (directory / '.env').write_text(saved)
            (directory / 'docker-compose.yml').write_text('services: {}\n')
            binaries = directory / 'bin'
            binaries.mkdir()
            for name, body in {
                'lsof': 'case "$*" in *":$TEST_OCCUPIED") [ -n "$TEST_OCCUPIED" ];; *) exit 1;; esac',
                'hostname': 'echo 192.168.50.10',
                'docker': 'case "$*" in *"ps -q web") [ -z "$TEST_INSTALLED" ] || echo own-web;; *inspect*) echo "$TEST_INSTALLED";; esac',
            }.items():
                path = binaries / name
                path.write_text('#!/bin/sh\n' + body + '\n')
                path.chmod(0o755)
            environment = {
                **os.environ, 'PATH': f'{binaries}:{os.environ["PATH"]}',
                'FLIGHT_FINDER_DIR': temporary, 'HOST_PORT': port, 'HOST_BIND_ADDRESS': binding,
                'TEST_OCCUPIED': occupied, 'TEST_INSTALLED': installed,
                'FLIGHT_FINDER_YES': '1',
            }
            result = subprocess.run(['bash', '-c', '''
set -euo pipefail
source "$1"
OS=linux
DC='docker compose'
CONTAINER_CMD=docker
ok() { :; }
warn() { :; }
fail() { echo "$1" >&2; exit 1; }
configure_install_network
printf '%s\n%s\n' "$HOST_PORT" "$INSTALL_PASSWORD_ORIGINS"
''', 'network-test', str(HELPER)], env=environment, capture_output=True, text=True, check=False)
            return result

    def test_fresh_install_enrolls_exact_local_and_lan_addresses(self):
        result = self.configure(port='3098')
        self.assertEqual(result.returncode, 0, result.stderr)
        port, origins = result.stdout.splitlines()
        self.assertEqual(port, '3098')
        self.assertEqual(set(json.loads(origins)), {
            'http://localhost:3098', 'http://127.0.0.1:3098',
            'http://[::1]:3098', 'http://192.168.50.10:3098',
        })

    def test_desktop_binding_does_not_enroll_lan(self):
        for binding, saved in [('127.0.0.1', ''), ('::1', ''), ('', 'HOST_BIND_ADDRESS=127.0.0.1\n')]:
            with self.subTest(binding=binding, saved=saved):
                result = self.configure(binding=binding, saved=saved)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(set(json.loads(result.stdout.splitlines()[1])), {
                    'http://localhost:3003', 'http://127.0.0.1:3003', 'http://[::1]:3003',
                })

    def test_busy_fresh_port_updates_all_generated_addresses(self):
        result = self.configure(occupied='3003')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], '3004')
        self.assertTrue(all(origin.endswith(':3004') for origin in json.loads(result.stdout.splitlines()[1])))

    def test_reinstall_keeps_saved_port_used_by_its_own_container(self):
        result = self.configure(saved='HOST_PORT=3098\n', occupied='3098', installed='3098')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], '3098')

    def test_saved_port_owned_by_another_service_stops_installation(self):
        result = self.configure(saved='HOST_PORT=3098\n', occupied='3098')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('occupied by another service', result.stderr)

    def test_invalid_ports_stop_before_configuration_is_generated(self):
        for port in ['0', '65536', '03003', '00008', 'bad', '3003\nAPP_URL=https://evil.example']:
            with self.subTest(port=port):
                result = self.configure(port=port)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def test_readiness_requires_both_health_and_an_allowed_login_origin(self):
        for health, origin, expected in [('0', '0', 0), ('0', '1', 1), ('1', '0', 1)]:
            with self.subTest(health=health, origin=origin), tempfile.TemporaryDirectory() as temporary:
                curl = Path(temporary) / 'curl'
                curl.write_text('#!/bin/sh\ncase "$*" in *api/health*) exit "$TEST_HEALTH";; *) exit "$TEST_ORIGIN";; esac\n')
                curl.chmod(0o755)
                result = subprocess.run(['bash', '-c', '''
set -euo pipefail
source "$1"
HOST_PORT=3098
FLIGHT_FINDER_STARTUP_TIMEOUT=1
fail() { echo "$1" >&2; exit 1; }
wait_for_install_access
echo ready
''', 'readiness-test', str(HELPER)], env={
                    **os.environ, 'PATH': f'{temporary}:{os.environ["PATH"]}', 'TEST_HEALTH': health, 'TEST_ORIGIN': origin,
                }, capture_output=True, text=True, timeout=5, check=False)
                self.assertEqual(result.returncode, expected, result.stderr)
                if expected:
                    self.assertNotIn('ready', result.stdout)
                    self.assertIn('diagnose startup' if health == '1' else 'access origin', result.stderr)


if __name__ == '__main__':
    unittest.main()
