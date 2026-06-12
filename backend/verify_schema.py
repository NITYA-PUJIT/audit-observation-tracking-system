from common import verify_required_tables


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


if __name__ == "__main__":
    print(verify_required_tables(REQUIRED_TABLES, "Audit observation"))
