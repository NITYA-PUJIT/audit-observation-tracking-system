from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from collections import Counter, defaultdict
from datetime import date, datetime
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from werkzeug.security import check_password_hash

from common import (
    DB_NAME,
    PORT,
    clean_text,
    db_connection,
    execute,
    insert,
    install_exception_handlers,
    normalize_code,
    query_all,
    query_one,
    verify_required_tables,
)


app = FastAPI(title="Audit Observation Tracking API", version="1.0.0")
install_exception_handlers(app)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5176",
        "http://localhost:5176",
        "http://127.0.0.1:4176",
        "http://localhost:4176",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SESSIONS: dict[str, dict[str, Any]] = {}
REQUIRED_TABLES = [
    "audit_observations",
    "audit_observation_responses",
    "users",
    "roles",
    "permissions",
    "role_permissions",
    "offices",
    "user_sessions",
]
RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
LATEST_RESPONSE_JOIN = """
LEFT JOIN (
    SELECT resp.response_id,
           resp.observation_id,
           resp.response_date,
           resp.response_by,
           resp.response_text,
           resp.action_taken,
           resp.closure_status
    FROM audit_observation_responses resp
    INNER JOIN (
        SELECT observation_id, MAX(response_id) AS max_response_id
        FROM audit_observation_responses
        GROUP BY observation_id
    ) latest
        ON latest.max_response_id = resp.response_id
) latest_response
    ON latest_response.observation_id = obs.observation_id
"""


@app.on_event("startup")
def _startup() -> None:
    verify_required_tables(REQUIRED_TABLES, "Audit observation")


def verify_django_pbkdf2_sha256(encoded: str | None, password: str | None) -> bool:
    if not encoded or not password:
        return False

    try:
        algorithm, iterations, salt, digest = encoded.split("$", 3)
    except ValueError:
        return False

    if algorithm != "pbkdf2_sha256":
        return False

    calculated = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
    return hmac.compare_digest(calculated, digest)


def verify_user_password(input_value: str | None, stored_value: str | None) -> bool:
    if not input_value or not stored_value:
        return False

    if stored_value.startswith(("scrypt:", "pbkdf2:", "sha256:", "sha1:", "md5:")):
        return check_password_hash(stored_value, input_value)

    if stored_value.startswith("pbkdf2_sha256$"):
        return verify_django_pbkdf2_sha256(stored_value, input_value)

    return stored_value == input_value


def serialize_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = clean_text(value)
    return text or None


def serialize_datetime(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    text = clean_text(value)
    return text or None


def get_user_record(connection, username: str) -> dict[str, Any] | None:
    return query_one(
        connection,
        """
        SELECT u.id,
               u.username,
               u.password_hash,
               u.full_name,
               u.email,
               u.mobile,
               u.office_id,
               u.status,
               u.last_login,
               r.id AS role_id,
               r.role_name,
               r.description AS role_description,
               o.office_name,
               o.office_code,
               o.office_type
        FROM users u
        INNER JOIN roles r ON r.id = u.role_id
        LEFT JOIN offices o ON o.id = u.office_id
        WHERE u.username = %s
        LIMIT 1
        """,
        [username],
    )


def get_permission_codes(connection, role_id: int) -> list[str]:
    rows = query_all(
        connection,
        """
        SELECT p.permission_code
        FROM role_permissions rp
        INNER JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = %s
        ORDER BY p.permission_code
        """,
        [role_id],
    )
    return [normalize_code(row["permission_code"]) for row in rows]


def build_capabilities(role_name: str, permission_codes: list[str]) -> dict[str, bool]:
    normalized_role = normalize_code(role_name)
    permission_set = set(permission_codes)
    audit_view = "AUDIT_VIEW" in permission_set or normalized_role in {"ADMIN", "AUDITOR"}
    can_create = normalized_role in {"ADMIN", "AUDITOR"}
    can_respond = normalized_role in {"ADMIN", "CIRCLE_OFFICER"}
    can_verify = normalized_role in {"ADMIN", "AUDITOR"}

    return {
        "viewDashboard": audit_view,
        "viewObservations": audit_view,
        "createObservation": can_create,
        "submitResponse": can_respond,
        "verifyClosure": can_verify,
        "viewReports": audit_view,
    }


def serialize_user(user_row: dict[str, Any], permission_codes: list[str]) -> dict[str, Any]:
    capabilities = build_capabilities(user_row["role_name"], permission_codes)
    return {
        "id": int(user_row["id"]),
        "username": user_row["username"],
        "fullName": user_row["full_name"],
        "email": user_row.get("email"),
        "mobile": user_row.get("mobile"),
        "status": normalize_code(user_row.get("status")),
        "roleId": int(user_row["role_id"]),
        "roleName": normalize_code(user_row["role_name"]),
        "roleDescription": user_row.get("role_description"),
        "officeId": int(user_row["office_id"]) if user_row.get("office_id") else None,
        "officeName": user_row.get("office_name"),
        "officeCode": user_row.get("office_code"),
        "officeType": normalize_code(user_row.get("office_type")),
        "lastLogin": serialize_datetime(user_row.get("last_login")),
        "permissionCodes": permission_codes,
        "capabilities": capabilities,
    }


def require_capability(user: dict[str, Any], capability: str) -> None:
    if not user.get("capabilities", {}).get(capability):
        raise HTTPException(status_code=403, detail="You do not have permission to perform this action.")


def is_global_user(user: dict[str, Any]) -> bool:
    return user.get("roleName") in {"ADMIN", "AUDITOR"}


def get_accessible_office_ids(connection, user: dict[str, Any]) -> list[int] | None:
    if is_global_user(user):
        return None

    office_id = user.get("officeId")
    if not office_id:
        return []

    rows = query_all(
        connection,
        """
        WITH RECURSIVE office_scope AS (
            SELECT id, parent_office_id
            FROM offices
            WHERE id = %s

            UNION ALL

            SELECT child.id, child.parent_office_id
            FROM offices child
            INNER JOIN office_scope scope ON scope.id = child.parent_office_id
        )
        SELECT id
        FROM office_scope
        """,
        [office_id],
    )
    return [int(row["id"]) for row in rows]


def build_office_filter_clause(office_ids: list[int] | None) -> tuple[str, list[Any]]:
    if office_ids is None:
        return "", []
    if not office_ids:
        return "WHERE 1 = 0", []
    placeholders = ", ".join(["%s"] * len(office_ids))
    return f"WHERE obs.office_id IN ({placeholders})", office_ids


def serialize_response_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "responseId": int(row["response_id"]),
        "observationId": int(row["observation_id"]),
        "responseDate": serialize_date(row.get("response_date")),
        "responseBy": clean_text(row.get("response_by")),
        "responseText": clean_text(row.get("response_text")),
        "actionTaken": clean_text(row.get("action_taken")),
        "closureStatus": normalize_code(row.get("closure_status")) or "PENDING_REVIEW",
    }


def derive_progress_stage(observation: dict[str, Any]) -> str:
    if observation["status"] == "CLOSED":
        return "Closed"
    latest = observation.get("latestResponse")
    if latest and latest.get("closureStatus") == "PENDING_REVIEW":
        return "Pending Closure"
    if observation["isOverdue"]:
        return "Overdue"
    if observation["status"] == "RESPONDED":
        return "Responded"
    return "Open"


def serialize_observation_row(row: dict[str, Any]) -> dict[str, Any]:
    latest_response = None
    if row.get("latest_response_id"):
        latest_response = {
            "responseId": int(row["latest_response_id"]),
            "responseDate": serialize_date(row.get("latest_response_date")),
            "responseBy": clean_text(row.get("latest_response_by")),
            "responseText": clean_text(row.get("latest_response_text")),
            "actionTaken": clean_text(row.get("latest_action_taken")),
            "closureStatus": normalize_code(row.get("latest_closure_status")) or "PENDING_REVIEW",
        }

    normalized_status = normalize_code(row.get("status")) or "OPEN"
    target_date = serialize_date(row.get("target_closure_date"))
    overdue = bool(target_date and normalized_status != "CLOSED" and target_date < date.today().isoformat())

    observation = {
        "observationId": int(row["observation_id"]),
        "observationNo": row["observation_no"],
        "auditYear": int(row["audit_year"]) if row.get("audit_year") else None,
        "department": clean_text(row.get("department")),
        "officeId": int(row["office_id"]) if row.get("office_id") else None,
        "officeName": clean_text(row.get("office_name")),
        "officeCode": clean_text(row.get("office_code")),
        "officeType": normalize_code(row.get("office_type")),
        "observationDate": serialize_date(row.get("observation_date")),
        "observationSummary": clean_text(row.get("observation_summary")),
        "riskLevel": normalize_code(row.get("risk_level")) or "LOW",
        "targetClosureDate": target_date,
        "status": normalized_status,
        "latestResponse": latest_response,
        "isOverdue": overdue,
    }
    observation["progressStage"] = derive_progress_stage(observation)
    return observation


def build_dataset(user: dict[str, Any]) -> dict[str, Any]:
    with db_connection() as connection:
        office_ids = get_accessible_office_ids(connection, user)
        where_clause, where_params = build_office_filter_clause(office_ids)

        observations = [
            serialize_observation_row(row)
            for row in query_all(
                connection,
                f"""
                SELECT obs.observation_id,
                       obs.observation_no,
                       obs.audit_year,
                       obs.department,
                       obs.office_id,
                       obs.observation_date,
                       obs.observation_summary,
                       obs.risk_level,
                       obs.target_closure_date,
                       obs.status,
                       office.office_name,
                       office.office_code,
                       office.office_type,
                       latest_response.response_id AS latest_response_id,
                       latest_response.response_date AS latest_response_date,
                       latest_response.response_by AS latest_response_by,
                       latest_response.response_text AS latest_response_text,
                       latest_response.action_taken AS latest_action_taken,
                       latest_response.closure_status AS latest_closure_status
                FROM audit_observations obs
                LEFT JOIN offices office ON office.id = obs.office_id
                {LATEST_RESPONSE_JOIN}
                {where_clause}
                ORDER BY
                    COALESCE(obs.target_closure_date, obs.observation_date) ASC,
                    obs.observation_id DESC
                """,
                where_params,
            )
        ]

        observation_ids = [item["observationId"] for item in observations]
        response_history: list[dict[str, Any]] = []
        if observation_ids:
            placeholders = ", ".join(["%s"] * len(observation_ids))
            response_history = [
                serialize_response_row(row)
                for row in query_all(
                    connection,
                    f"""
                    SELECT response_id,
                           observation_id,
                           response_date,
                           response_by,
                           response_text,
                           action_taken,
                           closure_status
                    FROM audit_observation_responses
                    WHERE observation_id IN ({placeholders})
                    ORDER BY observation_id, response_date DESC, response_id DESC
                    """,
                    observation_ids,
                )
            ]

        office_rows = query_all(
            connection,
            """
            SELECT id, office_code, office_name, office_type
            FROM offices
            WHERE status = 'ACTIVE'
            ORDER BY office_type, office_name
            """,
        )

    history_by_observation: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for response in response_history:
        history_by_observation[response["observationId"]].append(response)

    for observation in observations:
        observation["responses"] = history_by_observation.get(observation["observationId"], [])

    departments = sorted({item["department"] for item in observations if item["department"]})
    offices = [
        {
            "officeId": int(row["id"]),
            "officeCode": row["office_code"],
            "officeName": row["office_name"],
            "officeType": normalize_code(row["office_type"]),
        }
        for row in office_rows
    ]
    return {"observations": observations, "departments": departments, "offices": offices}


def build_metrics(observations: list[dict[str, Any]]) -> dict[str, int]:
    counter = Counter()
    for item in observations:
        counter["total"] += 1
        counter[item["status"].lower()] += 1
        if item["isOverdue"]:
            counter["overdue"] += 1
        if not item.get("responses") and item["status"] != "CLOSED":
            counter["awaitingResponse"] += 1
        if item.get("latestResponse", {}).get("closureStatus") == "PENDING_REVIEW":
            counter["pendingClosure"] += 1

    return {
        "totalObservations": counter["total"],
        "openObservations": counter["open"],
        "respondedObservations": counter["responded"],
        "closedObservations": counter["closed"],
        "overdueObservations": counter["overdue"],
        "awaitingResponse": counter["awaitingResponse"],
        "pendingClosure": counter["pendingClosure"],
    }


def build_reports(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for item in observations:
        department = item["department"] or "Unassigned"
        bucket = grouped.setdefault(
            department,
            {
                "department": department,
                "total": 0,
                "open": 0,
                "responded": 0,
                "closed": 0,
                "overdue": 0,
                "critical": 0,
            },
        )
        bucket["total"] += 1
        if item["status"] == "OPEN":
            bucket["open"] += 1
        if item["status"] == "RESPONDED":
            bucket["responded"] += 1
        if item["status"] == "CLOSED":
            bucket["closed"] += 1
        if item["isOverdue"]:
            bucket["overdue"] += 1
        if item["riskLevel"] == "CRITICAL":
            bucket["critical"] += 1

    return sorted(grouped.values(), key=lambda row: (-row["overdue"], row["department"]))


def build_focus_lists(observations: list[dict[str, Any]]) -> dict[str, Any]:
    pending_response = [item for item in observations if item["status"] == "OPEN"]
    pending_closure = [
        item
        for item in observations
        if item.get("latestResponse", {}).get("closureStatus") == "PENDING_REVIEW"
    ]
    recent_responses = []
    for item in observations:
        for response in item.get("responses", [])[:1]:
            recent_responses.append(
                {
                    "observationId": item["observationId"],
                    "observationNo": item["observationNo"],
                    "department": item["department"],
                    **response,
                }
            )
    recent_responses.sort(
        key=lambda response: (response.get("responseDate") or "", response["responseId"]),
        reverse=True,
    )

    return {
        "pendingResponse": pending_response[:8],
        "pendingClosure": pending_closure[:8],
        "recentResponses": recent_responses[:8],
    }


def build_bootstrap(user: dict[str, Any]) -> dict[str, Any]:
    dataset = build_dataset(user)
    observations = dataset["observations"]
    return {
        "user": user,
        "capabilities": user["capabilities"],
        "dataSource": DB_NAME,
        "metrics": build_metrics(observations),
        "observations": observations,
        "reports": build_reports(observations),
        "focus": build_focus_lists(observations),
        "lookups": {
            "departments": dataset["departments"],
            "offices": dataset["offices"],
            "riskLevels": RISK_LEVELS,
            "observationStatuses": ["OPEN", "RESPONDED", "CLOSED"],
            "closureStatuses": ["PENDING_REVIEW", "ACCEPTED", "REOPENED"],
            "demoCredentials": [
                {"username": "admin", "password": "admin123", "role": "ADMIN"},
                {"username": "auditor", "password": "admin123", "role": "AUDITOR"},
                {
                    "username": "complaints_officer",
                    "password": "admin123",
                    "role": "CIRCLE_OFFICER",
                },
            ],
        },
    }


def extract_bearer_token(authorization: str | None) -> str:
    value = clean_text(authorization)
    if not value or not value.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization token.")
    return value.split(" ", 1)[1].strip()


def get_current_user(authorization: str | None) -> dict[str, Any]:
    token = extract_bearer_token(authorization)
    session = SESSIONS.get(token)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired. Please login again.")

    session["lastSeen"] = datetime.now().isoformat()
    with db_connection() as connection:
        execute(connection, "UPDATE user_sessions SET last_activity = NOW() WHERE id = %s", [session["sessionId"]])
    return session["user"]


def generate_observation_no(connection, audit_year: int) -> str:
    prefix = f"AUD-OBS-{audit_year}-"
    last_row = query_one(
        connection,
        """
        SELECT observation_no
        FROM audit_observations
        WHERE observation_no LIKE %s
        ORDER BY observation_id DESC
        LIMIT 1
        """,
        [f"{prefix}%"],
    )

    next_number = 1
    if last_row:
        match = re.search(r"(\d+)$", clean_text(last_row.get("observation_no")))
        if match:
            next_number = int(match.group(1)) + 1

    return f"{prefix}{next_number:04d}"


def ensure_observation_access(connection, user: dict[str, Any], observation_id: int) -> dict[str, Any]:
    office_ids = get_accessible_office_ids(connection, user)
    where_clause, where_params = build_office_filter_clause(office_ids)
    observation = query_one(
        connection,
        f"""
        SELECT obs.observation_id,
               obs.observation_no,
               obs.audit_year,
               obs.department,
               obs.office_id,
               obs.observation_date,
               obs.observation_summary,
               obs.risk_level,
               obs.target_closure_date,
               obs.status
        FROM audit_observations obs
        {where_clause or 'WHERE 1 = 1'}
          AND obs.observation_id = %s
        LIMIT 1
        """,
        [*where_params, observation_id],
    )
    if not observation:
        raise HTTPException(status_code=404, detail="Observation was not found in your scope.")
    return observation


@app.get("/api/health")
def health() -> dict[str, Any]:
    message = verify_required_tables(REQUIRED_TABLES, "Audit observation")
    return {"status": "ok", "database": DB_NAME, "message": message}


@app.post("/api/auth/login")
def login(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    username = clean_text(payload.get("username"))
    password = str(payload.get("password") or "").strip()
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required.")

    with db_connection() as connection:
        user_row = get_user_record(connection, username)
        if not user_row or normalize_code(user_row.get("status")) != "ACTIVE":
            raise HTTPException(status_code=401, detail="Invalid username or password.")

        if not verify_user_password(password, user_row.get("password_hash")):
            raise HTTPException(status_code=401, detail="Invalid username or password.")

        permission_codes = get_permission_codes(connection, int(user_row["role_id"]))
        user = serialize_user(user_row, permission_codes)
        if not user["capabilities"]["viewDashboard"]:
            raise HTTPException(status_code=403, detail="This user does not have access to the audit portal.")

        session_id = insert(
            connection,
            """
            INSERT INTO user_sessions (user_id, login_time, last_activity, is_active)
            VALUES (%s, NOW(), NOW(), 1)
            """,
            [user["id"]],
        )
        execute(connection, "UPDATE users SET last_login = NOW() WHERE id = %s", [user["id"]])

    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {"sessionId": session_id, "user": user, "username": user["username"]}
    return {"token": token, "user": user, "bootstrap": build_bootstrap(user)}


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token = extract_bearer_token(authorization)
    session = SESSIONS.pop(token, None)
    if session:
        with db_connection() as connection:
            execute(
                connection,
                """
                UPDATE user_sessions
                SET logout_time = NOW(),
                    duration_seconds = TIMESTAMPDIFF(SECOND, login_time, NOW()),
                    is_active = 0
                WHERE id = %s
                """,
                [session["sessionId"]],
            )
    return {"ok": True}


@app.get("/api/bootstrap")
def bootstrap(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = get_current_user(authorization)
    return build_bootstrap(user)


@app.post("/api/observations")
def create_observation(
    payload: dict[str, Any] = Body(...),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = get_current_user(authorization)
    require_capability(user, "createObservation")

    department = clean_text(payload.get("department"))
    office_id = payload.get("officeId")
    observation_date = clean_text(payload.get("observationDate"))
    summary = clean_text(payload.get("observationSummary"))
    risk_level = normalize_code(payload.get("riskLevel")) or "LOW"
    target_closure_date = clean_text(payload.get("targetClosureDate"))
    audit_year = int(payload.get("auditYear") or observation_date[:4] or date.today().year)

    if not department or not office_id or not observation_date or not summary or not target_closure_date:
        raise HTTPException(status_code=400, detail="Please complete all observation fields.")
    if risk_level not in RISK_LEVELS:
        raise HTTPException(status_code=400, detail="Invalid risk level.")

    with db_connection() as connection:
        office = query_one(connection, "SELECT id FROM offices WHERE id = %s LIMIT 1", [office_id])
        if not office:
            raise HTTPException(status_code=400, detail="Selected office was not found.")

        observation_no = generate_observation_no(connection, audit_year)
        observation_id = insert(
            connection,
            """
            INSERT INTO audit_observations (
                observation_no,
                audit_year,
                department,
                office_id,
                observation_date,
                observation_summary,
                risk_level,
                target_closure_date,
                status
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'OPEN')
            """,
            [
                observation_no,
                audit_year,
                department,
                int(office_id),
                observation_date,
                summary,
                risk_level,
                target_closure_date,
            ],
        )

    return {"createdObservationId": observation_id, "bootstrap": build_bootstrap(user)}


@app.post("/api/observations/{observation_id}/responses")
def submit_response(
    observation_id: int,
    payload: dict[str, Any] = Body(...),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = get_current_user(authorization)
    require_capability(user, "submitResponse")

    response_text = clean_text(payload.get("responseText"))
    action_taken = clean_text(payload.get("actionTaken"))
    response_date = clean_text(payload.get("responseDate")) or date.today().isoformat()
    if not response_text or not action_taken:
        raise HTTPException(status_code=400, detail="Response and action taken are required.")

    with db_connection() as connection:
        observation = ensure_observation_access(connection, user, observation_id)
        if normalize_code(observation.get("status")) == "CLOSED":
            raise HTTPException(status_code=400, detail="Closed observations cannot receive a new department response.")

        insert(
            connection,
            """
            INSERT INTO audit_observation_responses (
                observation_id,
                response_date,
                response_by,
                response_text,
                action_taken,
                closure_status
            )
            VALUES (%s, %s, %s, %s, %s, 'PENDING_REVIEW')
            """,
            [observation_id, response_date, user["fullName"], response_text, action_taken],
        )
        execute(
            connection,
            """
            UPDATE audit_observations
            SET status = 'RESPONDED'
            WHERE observation_id = %s
            """,
            [observation_id],
        )

    return {"bootstrap": build_bootstrap(user)}


@app.post("/api/observations/{observation_id}/closure")
def close_observation(
    observation_id: int,
    payload: dict[str, Any] = Body(...),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = get_current_user(authorization)
    require_capability(user, "verifyClosure")

    decision = normalize_code(payload.get("decision"))
    note = clean_text(payload.get("note"))
    action_taken = clean_text(payload.get("actionTaken"))
    response_date = clean_text(payload.get("responseDate")) or date.today().isoformat()
    if decision not in {"ACCEPTED", "REOPENED"}:
        raise HTTPException(status_code=400, detail="Decision must be ACCEPTED or REOPENED.")

    with db_connection() as connection:
        ensure_observation_access(connection, user, observation_id)
        insert(
            connection,
            """
            INSERT INTO audit_observation_responses (
                observation_id,
                response_date,
                response_by,
                response_text,
                action_taken,
                closure_status
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            [
                observation_id,
                response_date,
                user["fullName"],
                note or ("Observation closed after verification." if decision == "ACCEPTED" else "Observation reopened."),
                action_taken or ("Closure accepted by reviewer." if decision == "ACCEPTED" else "Observation reopened for more action."),
                decision,
            ],
        )
        execute(
            connection,
            """
            UPDATE audit_observations
            SET status = %s
            WHERE observation_id = %s
            """,
            ["CLOSED" if decision == "ACCEPTED" else "OPEN", observation_id],
        )

    return {"bootstrap": build_bootstrap(user)}


if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=PORT, reload=False)
