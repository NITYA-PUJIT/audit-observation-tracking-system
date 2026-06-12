from app import app
from common import PORT

import uvicorn


__all__ = ["app"]


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=PORT, reload=False)
