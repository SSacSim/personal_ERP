from unittest.mock import patch

from app import auth
from app.auth_store import AuthStore


def authorize(client, stack, root, name="홍길동"):
    """Use a real, isolated session without initializing the live vault."""
    store = AuthStore(root / "Auth")
    store.ensure()
    stack.enter_context(patch.object(auth, "store", store))
    admin = store.list_users()[0]
    with store.connect() as db:
        db.execute("UPDATE users SET name = ? WHERE id = ?", (name, admin["id"]))
    client.cookies.set(auth.COOKIE_NAME, store.create_session(admin["id"]))
    return store
