from __future__ import annotations

import uvicorn

from app.config import SERVER_HOST, SERVER_PORT, SERVER_RELOAD


def main() -> None:
    uvicorn.run(
        "app.main:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        reload=SERVER_RELOAD,
    )


if __name__ == "__main__":
    main()
