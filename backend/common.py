from __future__ import annotations

import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

import pymysql
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "power_billing_db")
PORT = int(os.getenv("PORT", "4310"))


def _connection_kwargs(use_database: bool = True) -> dict[str, Any]:
    options: dict[str, Any] = {
        "host": DB_HOST,
        "port": DB_PORT,
        "user": DB_USER,
        "password": DB_PASSWORD,
        "cursorclass": pymysql.cursors.DictCursor,
        "charset": "utf8mb4",
        "autocommit": False,
    }

    if use_database:
        options["database"] = DB_NAME

    return options


@contextmanager
def db_connection(use_database: bool = True):
    connection = pymysql.connect(**_connection_kwargs(use_database=use_database))
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def query_all(connection, sql: str, params: Iterable[Any] | None = None) -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(sql, tuple(params or ()))
        return list(cursor.fetchall())


def query_one(connection, sql: str, params: Iterable[Any] | None = None) -> dict[str, Any] | None:
    rows = query_all(connection, sql, params)
    return rows[0] if rows else None


def execute(connection, sql: str, params: Iterable[Any] | None = None) -> int:
    with connection.cursor() as cursor:
        cursor.execute(sql, tuple(params or ()))
        return cursor.rowcount


def insert(connection, sql: str, params: Iterable[Any] | None = None) -> int:
    with connection.cursor() as cursor:
        cursor.execute(sql, tuple(params or ()))
        return int(cursor.lastrowid)


def clean_text(value: Any) -> str:
    text = str(value or "")
    text = text.replace("\r", " ").replace("\n", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_code(value: Any) -> str:
    return clean_text(value).replace(" ", "_").replace("-", "_").upper()


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(HTTPException)
    async def _http_exception_handler(_request: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"message": exc.detail})

    @app.exception_handler(RequestValidationError)
    async def _validation_exception_handler(_request: Request, exc: RequestValidationError):
        message = exc.errors()[0].get("msg", "Invalid request.") if exc.errors() else "Invalid request."
        return JSONResponse(status_code=422, content={"message": message})

    @app.exception_handler(Exception)
    async def _generic_exception_handler(_request: Request, exc: Exception):
        message = str(exc).strip() or "Internal server error."
        return JSONResponse(status_code=500, content={"message": message})


def verify_required_tables(required_tables: list[str], label: str) -> str:
    with db_connection(use_database=False) as connection:
        schema_row = query_one(
            connection,
            """
            SELECT SCHEMA_NAME
            FROM information_schema.schemata
            WHERE SCHEMA_NAME = %s
            """,
            [DB_NAME],
        )

        if not schema_row:
            raise RuntimeError(f"Database {DB_NAME} was not found in MySQL Workbench.")

        table_rows = query_all(
            connection,
            """
            SELECT TABLE_NAME
            FROM information_schema.tables
            WHERE TABLE_SCHEMA = %s
            """,
            [DB_NAME],
        )

    available_tables = {row["TABLE_NAME"] for row in table_rows}
    missing_tables = [table_name for table_name in required_tables if table_name not in available_tables]

    if missing_tables:
        raise RuntimeError(
            f"Missing {label} tables in {DB_NAME}: {', '.join(missing_tables)}. "
            "Create or import them in MySQL Workbench."
        )

    return f"{label} schema verified against {DB_NAME}."
