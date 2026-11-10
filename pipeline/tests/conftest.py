import sys
from pathlib import Path

# Pipeline modules live in pipeline/ (not a package); make them importable from tests.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
