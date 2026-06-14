from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.getenv("GAI_ERP_HOST", "127.0.0.1")
    port = int(os.getenv("GAI_ERP_PORT", "8010"))
    reload = os.getenv("GAI_ERP_RELOAD", "true").lower() in {"1", "true", "yes", "on"}

    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=reload,
    )


if __name__ == "__main__":
    main()
