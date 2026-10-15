"""Run actual updater shell processes against download/container boundaries."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'apps/web/public'


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='flight-finder-bootstrap-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        self.install = self.directory / 'install'
        self.install.mkdir()
        (self.install / 'docker-compose.yml').write_text('services: {}\n')
        (self.install / '.env').write_text('HOST_PORT=3098\nSECRET=unchanged\n')
        for name in ['flight-finder-cli', 'flight-finder-cli-flags.sh']:
            shutil.copyfile(PUBLIC / name, self.bin / name.replace('-cli', '', 1) if name == 'flight-finder-cli' else self.bin / name)
        self.cli = self.bin / 'flight-finder'
        self.cli.chmod(0o755)
        self.write_boundary('docker', '''
case "$*" in
  'compose version') exit 0;;
  *config*) echo 'unsupported provider: SECRET=do-not-print'; exit 1;;
  *) echo "$*" >> "$TEST_ACTIONS"; exit 0;;
esac
''')
        self.write_boundary('curl', '''
url=""
destination=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; destination="$1";;
    https://*) url="$1";;
  esac
  shift
done
asset="${url#https://fixture.invalid/}"
printf '%s\\n' "$asset" >> "$TEST_DOWNLOADS"
[ "$asset" != "${TEST_FAILED_ASSET:-}" ] || exit 22
if [ "$asset" = "${TEST_EMPTY_ASSET:-}" ]; then
  : > "$destination"
elif [ "$asset" = "${TEST_BAD_ASSET:-}" ]; then
  printf 'invalid ( syntax' > "$destination"
else
  cp "$TEST_PUBLIC/$asset" "$destination"
fi
''')
        self.environment = {**os.environ, 'PATH': f'{self.bin}:{os.environ["PATH"]}',
                            'FLIGHT_FINDER_DIR': str(self.install), 'FLIGHT_FINDER_URL': 'https://fixture.invalid',
                            'TEST_PUBLIC': str(PUBLIC), 'TEST_DOWNLOADS': str(self.directory / 'downloads'),
                            'TEST_ACTIONS': str(self.directory / 'actions')}
        self.environment.pop('FLIGHT_FINDER_UPDATE_STAGE', None)
        self.environment.pop('FLIGHT_FINDER_UPDATE_TARGET', None)

    def write_boundary(self, name, source):
        path = self.bin / name
        path.write_text('#!/usr/bin/env bash\nset -eu\n' + source)
        path.chmod(0o755)

    def invoke(self, **environment):
        return subprocess.run(['bash', str(self.cli), 'update'], env={**self.environment, **environment},
                              capture_output=True, text=True, timeout=15)

    def test_downloaded_updater_reexecutes_once_and_rejects_unsupported_provider(self):
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--no-env-resolution support', result.stderr)
        self.assertNotIn('do-not-print', result.stderr)
        self.assertEqual((self.directory / 'downloads').read_text().splitlines(), [
            'flight-finder-cli', 'flight-finder-cli-flags.sh', 'install/network.sh', 'install/update.py',
        ])
        self.assertFalse((self.directory / 'actions').exists())
        self.assertEqual(list(self.bin.glob('.flight-finder-update.*')), [])
        self.assertFalse((self.install / '.flight-finder-update.lock').exists())

    def test_partial_download_does_not_replace_installed_cli_or_change_services(self):
        original = self.cli.read_bytes()
        result = self.invoke(TEST_FAILED_ASSET='install/network.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('download failed', result.stderr)
        self.assertEqual(self.cli.read_bytes(), original)
        self.assertFalse((self.directory / 'actions').exists())
        self.assertEqual(list(self.bin.glob('.flight-finder-update.*')), [])

    def test_corrupt_updater_assets_abort_before_config_or_service_changes(self):
        for asset in ['flight-finder-cli', 'flight-finder-cli-flags.sh', 'install/network.sh', 'install/update.py']:
            with self.subTest(asset=asset):
                result = self.invoke(TEST_BAD_ASSET=asset)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.directory / 'actions').exists())
                self.assertEqual(list(self.bin.glob('.flight-finder-update.*')), [])
                self.assertEqual((self.install / '.env').read_text(), 'HOST_PORT=3098\nSECRET=unchanged\n')

    def test_forged_reexecution_marker_does_not_skip_asset_validation(self):
        result = self.invoke(FLIGHT_FINDER_UPDATE_STAGE='/tmp/not-the-current-cli')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid updater stage', result.stderr)
        self.assertFalse((self.directory / 'actions').exists())

    def test_empty_companion_is_rejected_before_replacing_the_cli(self):
        original = self.cli.read_bytes()
        result = self.invoke(TEST_EMPTY_ASSET='flight-finder-cli-flags.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('empty', result.stderr)
        self.assertEqual(self.cli.read_bytes(), original)
        self.assertFalse((self.directory / 'actions').exists())


if __name__ == '__main__':
    unittest.main()
