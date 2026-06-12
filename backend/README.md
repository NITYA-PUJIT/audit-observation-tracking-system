# Audit Observation Tracking Backend

This FastAPI service powers the Audit Observation Tracking frontend and reads live data from the MySQL schema `power_billing_db`.

## Features

- Authenticates against the existing `users`, `roles`, `role_permissions`, and `permissions` tables.
- Reads and writes live audit data from `audit_observations` and `audit_observation_responses`.
- Applies role-aware access:
  - `ADMIN` and `AUDITOR` can create observations and complete closure review.
  - `CIRCLE_OFFICER` users can submit department responses inside their office scope.
- Normalizes the live status values before sending them to the frontend.

## Configure

Use the same database credentials you already use in MySQL Workbench:

```env
PORT=4310
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=power_billing_db
```

## Run

```powershell
python verify_schema.py
python app.py
```

The API will start at `http://127.0.0.1:4310`.

## Working demo logins from the live database

- `admin / admin123`
- `auditor / admin123`
- `complaints_officer / admin123`
