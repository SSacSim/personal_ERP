from pathlib import Path
import os


BASE_DIR = Path(__file__).resolve().parent.parent
VAULT_DIR = Path(os.getenv("GAI_ERP_VAULT", BASE_DIR / "vault")).resolve()
APP_NAME = "GAI Company ERP"
