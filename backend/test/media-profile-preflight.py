from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations"))
import media_container


class ProfilePreflightTest(unittest.TestCase):
    def test_empty_profile_does_not_satisfy_supplier_configuration(self):
        with TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "workflow.md").touch()
            profile = source / "profile"
            nested = profile / "nested"
            nested.mkdir(parents=True)
            (nested / "empty").touch()
            with (
                patch.object(media_container, "SOURCE", source),
                patch.object(media_container, "PROFILE", profile),
                patch.object(media_container.shutil, "which", return_value="test-command"),
                patch.object(media_container.importlib.util, "find_spec", return_value=object()),
                patch.dict(media_container.os.environ, {"MEDIA_DOWNLOAD_HOSTS": "example.invalid", "MEDIA_IMAGE_MODEL": "test"}, clear=True),
            ):
                vendors = ("kling", "pixverse", "ark", "minimax", "dlazy", "vidu")
                for vendor in vendors:
                    with self.subTest(vendor=vendor):
                        self.assertEqual(media_container.preflight(vendor, ["workflow.md"], "image-test"), "credentials_required")
                (nested / "synthetic-profile").write_text("local configuration fixture", encoding="utf-8")
                for vendor in vendors:
                    with self.subTest(vendor=vendor):
                        self.assertEqual(media_container.preflight(vendor, ["workflow.md"], "image-test"), "configured")


if __name__ == "__main__":
    unittest.main()
