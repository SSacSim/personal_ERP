import os
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent.parent
APP_NAME = "GAI Company ERP"
CONFIG_PATH = Path(os.getenv("GAI_ERP_CONFIG", BASE_DIR / "config.yaml")).resolve()


def parse_config_value(value: str) -> Any:
    text = value.strip().strip('"').strip("'")
    lowered = text.lower()
    if lowered in {"true", "yes", "on", "1"}:
        return True
    if lowered in {"false", "no", "off", "0"}:
        return False
    if lowered in {"null", "none", "~"}:
        return None
    try:
        return int(text)
    except ValueError:
        return text


def load_simple_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}

    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        if ":" not in line:
            continue
        key, raw_value = line.strip().split(":", 1)
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if raw_value.strip() == "":
            child: dict[str, Any] = {}
            parent[key.strip()] = child
            stack.append((indent, child))
        else:
            parent[key.strip()] = parse_config_value(raw_value)
    return root


def get_config_value(config: dict[str, Any], dotted_key: str, default: Any) -> Any:
    value: Any = config
    for part in dotted_key.split("."):
        if not isinstance(value, dict) or part not in value:
            return default
        value = value[part]
    return value


def resolve_base_path(value: Any) -> Path:
    path = Path(str(value))
    if path.is_absolute():
        return path.resolve()
    return (BASE_DIR / path).resolve()


APP_CONFIG = load_simple_yaml(CONFIG_PATH)

VAULT_DIR = resolve_base_path(os.getenv("GAI_ERP_VAULT", get_config_value(APP_CONFIG, "vault.path", "vault")))
SERVER_HOST = str(os.getenv("GAI_ERP_HOST", get_config_value(APP_CONFIG, "server.host", "127.0.0.1")))
SERVER_PORT = int(os.getenv("GAI_ERP_PORT", get_config_value(APP_CONFIG, "server.port", 8010)))
SERVER_RELOAD = parse_config_value(str(os.getenv("GAI_ERP_RELOAD", get_config_value(APP_CONFIG, "server.reload", True)))) is True
