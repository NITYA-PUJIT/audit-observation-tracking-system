import React, { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_AUDIT_API_URL ?? "";
const TOKEN_KEY = "auditObservationTrackingToken";
const USER_KEY = "auditObservationTrackingUser";
const LOGIN_ROLES = [
  { key: "ADMIN", label: "Admin", username: "admin", password: "admin123" },
  { key: "AUDITOR", label: "Auditor", username: "auditor", password: "admin123" },
  {
    key: "CIRCLE_OFFICER",
    label: "Circle Officer",
    username: "complaints_officer",
    password: "admin123",
  },
];
const DEFAULT_LOGIN = { role: "", username: "", password: "" };
const SCREENS = [
  { key: "dashboard", label: "Dashboard", capability: "viewDashboard" },
  { key: "observations", label: "Observations", capability: "viewObservations" },
  { key: "responses", label: "Department Responses", capability: "submitResponse" },
  { key: "closure", label: "Compliance Closure", capability: "verifyClosure" },
  { key: "reports", label: "Reports", capability: "viewReports" },
];
const SCREEN_TITLES = {
  dashboard: "Audit Dashboard",
  observations: "Observation Register",
  responses: "Department Responses",
  closure: "Compliance Closure",
  reports: "Audit Reports",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function apiRequest(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.message || "Request failed.");
  }
  return payload;
}

function formatDate(value) {
  if (!value) {
    return "Not set";
  }
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function titleCase(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusTone(status) {
  switch (status) {
    case "CLOSED":
    case "ACCEPTED":
      return "status-chip bg-pine-100 text-pine-700";
    case "RESPONDED":
    case "PENDING_REVIEW":
      return "status-chip bg-cinder-100 text-cinder-700";
    case "HIGH":
      return "status-chip bg-ember-100 text-ember-500";
    case "CRITICAL":
    case "OVERDUE":
    case "REOPENED":
      return "status-chip bg-signal-100 text-signal-500";
    default:
      return "status-chip bg-amber-50 text-amber-700";
  }
}

function firstAvailableScreen(capabilities) {
  return SCREENS.find((screen) => capabilities?.[screen.capability])?.key || "dashboard";
}

function createObservationForm(lookups) {
  return {
    auditYear: new Date().getFullYear(),
    department: lookups?.departments?.[0] || "",
    officeId: lookups?.offices?.[0]?.officeId || "",
    observationDate: todayIso(),
    targetClosureDate: todayIso(),
    riskLevel: "MEDIUM",
    observationSummary: "",
  };
}

function getLoginRole(roleKey) {
  return LOGIN_ROLES.find((item) => item.key === roleKey) || null;
}

function joinParts(parts, separator = " / ") {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(separator);
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [sessionUser, setSessionUser] = useState(() => {
    const value = localStorage.getItem(USER_KEY);
    return value ? JSON.parse(value) : null;
  });
  const [bootstrap, setBootstrap] = useState(null);
  const [activeScreen, setActiveScreen] = useState("dashboard");
  const [loginForm, setLoginForm] = useState(DEFAULT_LOGIN);
  const [loginError, setLoginError] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [selectedObservationId, setSelectedObservationId] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [filters, setFilters] = useState({ department: "ALL", status: "ALL", risk: "ALL" });
  const [reportFilters, setReportFilters] = useState({ department: "ALL", status: "ALL" });
  const [observationForm, setObservationForm] = useState(createObservationForm());
  const [responseForm, setResponseForm] = useState({
    observationId: "",
    responseDate: todayIso(),
    responseText: "",
    actionTaken: "",
  });
  const [closureForm, setClosureForm] = useState({
    observationId: "",
    responseDate: todayIso(),
    decision: "ACCEPTED",
    note: "",
    actionTaken: "",
  });

  const deferredSearch = useDeferredValue(searchText);

  useEffect(() => {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }, [token]);

  useEffect(() => {
    if (sessionUser) {
      localStorage.setItem(USER_KEY, JSON.stringify(sessionUser));
    } else {
      localStorage.removeItem(USER_KEY);
    }
  }, [sessionUser]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const applyBootstrap = (data, preferredObservationId = null) => {
    setBootstrap(data);
    setSessionUser(data.user);

    const observations = data.observations || [];
    const observationIds = new Set(observations.map((item) => item.observationId));
    const fallbackId =
      preferredObservationId && observationIds.has(preferredObservationId)
        ? preferredObservationId
        : observationIds.has(selectedObservationId)
          ? selectedObservationId
          : observations[0]?.observationId || null;

    setSelectedObservationId(fallbackId);
    setResponseForm((current) => ({
      ...current,
      observationId: fallbackId || "",
      responseDate: current.responseDate || todayIso(),
    }));
    setClosureForm((current) => ({
      ...current,
      observationId: fallbackId || "",
      responseDate: current.responseDate || todayIso(),
    }));
    setObservationForm((current) => ({
      ...createObservationForm(data.lookups),
      ...current,
      department: current.department || data.lookups?.departments?.[0] || "",
      officeId: current.officeId || data.lookups?.offices?.[0]?.officeId || "",
      riskLevel: current.riskLevel || "MEDIUM",
    }));
    if (!bootstrap) {
      startTransition(() => setActiveScreen(firstAvailableScreen(data.capabilities)));
    }
  };

  const clearSession = () => {
    setToken("");
    setSessionUser(null);
    setBootstrap(null);
    setSelectedObservationId(null);
    setLoginForm({ ...DEFAULT_LOGIN });
    setLoginError("");
    setGlobalError("");
  };

  const refreshBootstrap = async (authToken = token, preferredObservationId = null) => {
    const payload = await apiRequest("/api/bootstrap", { token: authToken });
    applyBootstrap(payload, preferredObservationId);
    return payload;
  };

  useEffect(() => {
    if (!token || bootstrap) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    apiRequest("/api/bootstrap", { token })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        applyBootstrap(payload);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        clearSession();
        setLoginError(error.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, bootstrap]);

  const capabilities = bootstrap?.capabilities || sessionUser?.capabilities || {};
  const observations = bootstrap?.observations || [];
  const observationMap = useMemo(
    () => Object.fromEntries(observations.map((item) => [item.observationId, item])),
    [observations],
  );
  const selectedObservation = observationMap[selectedObservationId] || observations[0] || null;
  const visibleScreens = SCREENS.filter((screen) => capabilities[screen.capability]);

  const filteredObservations = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return observations.filter((item) => {
      if (filters.department !== "ALL" && item.department !== filters.department) {
        return false;
      }
      if (filters.status !== "ALL" && item.status !== filters.status) {
        return false;
      }
      if (filters.risk !== "ALL" && item.riskLevel !== filters.risk) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        item.observationNo,
        item.department,
        item.officeName,
        item.observationSummary,
        item.status,
        item.progressStage,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [deferredSearch, filters, observations]);

  const reportRows = useMemo(() => {
    const scoped = observations.filter((item) => {
      if (reportFilters.department !== "ALL" && item.department !== reportFilters.department) {
        return false;
      }
      if (reportFilters.status !== "ALL" && item.status !== reportFilters.status) {
        return false;
      }
      return true;
    });

    const grouped = {};
    scoped.forEach((item) => {
      const department = item.department || "Unassigned";
      const row = grouped[department] || {
        department,
        total: 0,
        open: 0,
        responded: 0,
        closed: 0,
        overdue: 0,
      };
      row.total += 1;
      row[item.status.toLowerCase()] += 1;
      if (item.isOverdue) {
        row.overdue += 1;
      }
      grouped[department] = row;
    });

    return Object.values(grouped).sort((left, right) => right.overdue - left.overdue || left.department.localeCompare(right.department));
  }, [observations, reportFilters]);

  const reportSummary = useMemo(() => {
    return reportRows.reduce(
      (summary, row) => ({
        total: summary.total + row.total,
        closed: summary.closed + row.closed,
        responded: summary.responded + row.responded,
        overdue: summary.overdue + row.overdue,
      }),
      { total: 0, closed: 0, responded: 0, overdue: 0 },
    );
  }, [reportRows]);

  const handleOpenObservation = (observationId, nextScreen = activeScreen) => {
    setSelectedObservationId(observationId);
    setResponseForm((current) => ({ ...current, observationId }));
    setClosureForm((current) => ({ ...current, observationId }));
    startTransition(() => setActiveScreen(nextScreen));
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    if (!loginForm.username.trim() || !loginForm.password.trim()) {
      setLoginError("Select a role or enter credentials.");
      return;
    }
    setLoading(true);
    setLoginError("");
    try {
      const payload = await apiRequest("/api/auth/login", {
        method: "POST",
        body: {
          username: loginForm.username.trim(),
          password: loginForm.password,
        },
      });
      setToken(payload.token);
      setSessionUser(payload.user);
      applyBootstrap(payload.bootstrap);
      setToast(`Signed in as ${payload.user.fullName}`);
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLoginRoleChange = (roleKey) => {
    const selectedRole = getLoginRole(roleKey);
    setLoginError("");
    setLoginForm({
      role: roleKey,
      username: selectedRole?.username || "",
      password: selectedRole?.password || "",
    });
  };

  const handleLogout = async () => {
    try {
      if (token) {
        await apiRequest("/api/auth/logout", { method: "POST", token });
      }
    } catch (_error) {
      // Ignore logout transport issues during local development.
    } finally {
      clearSession();
    }
  };

  const handleCreateObservation = async (event) => {
    event.preventDefault();
    setActionBusy("create");
    setGlobalError("");
    try {
      const payload = await apiRequest("/api/observations", {
        method: "POST",
        token,
        body: observationForm,
      });
      applyBootstrap(payload.bootstrap, payload.createdObservationId);
      setObservationForm(createObservationForm(bootstrap?.lookups));
      setToast("Observation created and synced to MySQL.");
      startTransition(() => setActiveScreen("observations"));
    } catch (error) {
      setGlobalError(error.message);
    } finally {
      setActionBusy("");
    }
  };

  const handleSubmitResponse = async (event) => {
    event.preventDefault();
    setActionBusy("response");
    setGlobalError("");
    try {
      const observationId = Number(responseForm.observationId);
      const payload = await apiRequest(`/api/observations/${observationId}/responses`, {
        method: "POST",
        token,
        body: responseForm,
      });
      applyBootstrap(payload.bootstrap, observationId);
      setResponseForm({
        observationId,
        responseDate: todayIso(),
        responseText: "",
        actionTaken: "",
      });
      setToast("Department response submitted to MySQL.");
    } catch (error) {
      setGlobalError(error.message);
    } finally {
      setActionBusy("");
    }
  };

  const handleClosure = async (event) => {
    event.preventDefault();
    setActionBusy("closure");
    setGlobalError("");
    try {
      const observationId = Number(closureForm.observationId);
      const payload = await apiRequest(`/api/observations/${observationId}/closure`, {
        method: "POST",
        token,
        body: closureForm,
      });
      applyBootstrap(payload.bootstrap, observationId);
      setClosureForm({
        observationId,
        responseDate: todayIso(),
        decision: "ACCEPTED",
        note: "",
        actionTaken: "",
      });
      setToast("Closure decision saved to MySQL.");
    } catch (error) {
      setGlobalError(error.message);
    } finally {
      setActionBusy("");
    }
  };

  if (token && !bootstrap) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="panel max-w-lg p-8 text-center">
          <div className="eyebrow">Restoring Session</div>
          <h2 className="mt-3 text-3xl font-semibold text-cinder-900">Loading live audit workspace</h2>
        </div>
      </div>
    );
  }

  if (!token || !bootstrap) {
    return (
        <LoginScreen
          form={loginForm}
          onChange={setLoginForm}
          onRoleChange={handleLoginRoleChange}
          onSubmit={handleLogin}
          error={loginError}
          loading={loading}
          roleOptions={LOGIN_ROLES}
        />
      );
  }

  return (
    <div className="relative min-h-screen px-4 py-5 md:px-6 xl:px-8">
      <div className="mx-auto grid max-w-[1660px] gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="panel p-5">
          <div className="rounded-[26px] bg-cinder-900 p-6 text-white">
            <div className="eyebrow text-white/60">Audit Console</div>
            <h1 className="mt-3 text-2xl font-semibold leading-tight">Audit Observation Tracking System</h1>
          </div>

          <div className="mt-6 space-y-2">
            {visibleScreens.map((screen) => (
              <button
                key={screen.key}
                type="button"
                className={`nav-pill w-full text-left ${activeScreen === screen.key ? "nav-pill-active" : ""}`}
                onClick={() => startTransition(() => setActiveScreen(screen.key))}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-current/80" />
                <span>{screen.label}</span>
              </button>
            ))}
          </div>

          <div className="mt-8 muted-panel p-4">
            <div className="eyebrow">Signed In</div>
            <div className="mt-3 text-lg font-semibold text-cinder-900">{sessionUser.fullName}</div>
            <div className="mt-1 text-sm text-cinder-500">
              {joinParts([titleCase(sessionUser.roleName), sessionUser.officeName || "Global"])}
            </div>
          </div>
        </aside>

        <main className="space-y-5">
          <section className="panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="eyebrow">{titleCase(activeScreen)}</div>
              <div className="mt-2 text-2xl font-semibold text-cinder-900">
                {SCREEN_TITLES[activeScreen] || "Audit Workspace"}
              </div>
              <div className="mt-2 text-sm text-cinder-500">
                {joinParts([sessionUser.fullName, sessionUser.officeName || "Global"])}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => refreshBootstrap(token, selectedObservationId)}
              >
                Refresh Live Data
              </button>
              <button type="button" className="btn-primary" onClick={handleLogout}>
                Logout
              </button>
            </div>
          </section>

          {toast ? (
            <div className="rounded-2xl border border-pine-200 bg-pine-100 px-4 py-3 text-sm font-semibold text-pine-700">
              {toast}
            </div>
          ) : null}

          {globalError ? (
            <div className="rounded-2xl border border-signal-200 bg-signal-100 px-4 py-3 text-sm font-semibold text-signal-500">
              {globalError}
            </div>
          ) : null}

          {activeScreen === "dashboard" ? (
            <DashboardScreen
              metrics={bootstrap.metrics}
              reports={bootstrap.reports}
              focus={bootstrap.focus}
              onOpenObservation={handleOpenObservation}
            />
          ) : null}

          {activeScreen === "observations" ? (
            <ObservationsScreen
              capabilities={capabilities}
              lookups={bootstrap.lookups}
              observations={filteredObservations}
              allObservations={observations}
              filters={filters}
              onFilterChange={setFilters}
              searchText={searchText}
              onSearchChange={setSearchText}
              selectedObservation={selectedObservation}
              onOpenObservation={handleOpenObservation}
              form={observationForm}
              onFormChange={setObservationForm}
              onSubmit={handleCreateObservation}
              actionBusy={actionBusy}
            />
          ) : null}

          {activeScreen === "responses" ? (
            <ResponsesScreen
              observations={observations}
              focus={bootstrap.focus}
              selectedObservation={observationMap[Number(responseForm.observationId)] || selectedObservation}
              form={responseForm}
              onFormChange={setResponseForm}
              onSubmit={handleSubmitResponse}
              onOpenObservation={handleOpenObservation}
              actionBusy={actionBusy}
            />
          ) : null}

          {activeScreen === "closure" ? (
            <ClosureScreen
              observations={observations}
              focus={bootstrap.focus}
              selectedObservation={observationMap[Number(closureForm.observationId)] || selectedObservation}
              form={closureForm}
              onFormChange={setClosureForm}
              onSubmit={handleClosure}
              onOpenObservation={handleOpenObservation}
              actionBusy={actionBusy}
            />
          ) : null}

          {activeScreen === "reports" ? (
            <ReportsScreen
              observations={observations}
              filters={reportFilters}
              onFilterChange={setReportFilters}
              reportRows={reportRows}
              summary={reportSummary}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function LoginScreen({ form, onChange, onRoleChange, onSubmit, error, loading, roleOptions }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-8">
      <div className="grid w-full max-w-6xl gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="panel overflow-hidden">
          <div className="flex h-full items-end bg-cinder-900 p-7 text-white md:p-10">
            <div>
              <div className="eyebrow text-white/60">Audit Portal</div>
              <h1 className="mt-4 max-w-xl text-4xl font-semibold leading-tight">
                Audit Observation Tracking System
              </h1>
            </div>
          </div>
        </section>

        <section className="panel p-7 md:p-10">
          <div className="eyebrow">Login</div>
          <h2 className="mt-3 text-3xl font-semibold text-cinder-900">Sign in</h2>

          <form className="mt-8 space-y-5" onSubmit={onSubmit}>
            <div>
              <label className="field-label" htmlFor="role">
                Role
              </label>
              <select
                id="role"
                className="input-field"
                value={form.role}
                onChange={(event) => onRoleChange(event.target.value)}
              >
                <option value="">Select role</option>
                {roleOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="field-label" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                className="input-field"
                value={form.username}
                onChange={(event) =>
                  onChange((current) => ({ ...current, username: event.target.value }))
                }
                placeholder="Enter username"
              />
            </div>

            <div>
              <label className="field-label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input-field"
                value={form.password}
                onChange={(event) =>
                  onChange((current) => ({ ...current, password: event.target.value }))
                }
                placeholder="Enter password"
              />
            </div>

            {error ? (
              <div className="rounded-2xl border border-signal-200 bg-signal-100 px-4 py-3 text-sm font-semibold text-signal-500">
                {error}
              </div>
            ) : null}

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? "Signing In..." : "Open Audit Portal"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function DashboardScreen({ metrics, reports, focus, onOpenObservation }) {
  return (
    <div className="space-y-5">
      <section className="grid gap-4 xl:grid-cols-[1.15fr_repeat(3,minmax(0,1fr))]">
        <div className="panel overflow-hidden bg-cinder-900 p-6 text-white">
          <div className="eyebrow text-white/60">Overview</div>
          <h2 className="mt-3 text-3xl font-semibold">Audit activity at a glance</h2>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[22px] border border-white/10 bg-white/10 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Open</div>
              <div className="mt-3 text-3xl font-semibold">{metrics.openObservations}</div>
            </div>
            <div className="rounded-[22px] border border-white/10 bg-white/10 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Responded</div>
              <div className="mt-3 text-3xl font-semibold">{metrics.respondedObservations}</div>
            </div>
            <div className="rounded-[22px] border border-white/10 bg-white/10 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Closed</div>
              <div className="mt-3 text-3xl font-semibold">{metrics.closedObservations}</div>
            </div>
          </div>
        </div>
        <MetricCard
          title="Total Observations"
          value={metrics.totalObservations}
          accent="from-cinder-900 to-cinder-700"
        />
        <MetricCard
          title="Awaiting Response"
          value={metrics.awaitingResponse}
          accent="from-amber-500 to-ember-500"
        />
        <MetricCard
          title="Pending Closure"
          value={metrics.pendingClosure}
          accent="from-cinder-600 to-slate-500"
        />
        <MetricCard
          title="Overdue"
          value={metrics.overdueObservations}
          accent="from-signal-500 to-rose-400"
        />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="panel p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="eyebrow">Department Queue</div>
              <h3 className="section-title mt-2">Observations waiting on action</h3>
            </div>
          </div>
          <div className="space-y-3">
            {focus.pendingResponse.length ? (
              focus.pendingResponse.map((item) => (
                <QueueCard
                  key={item.observationId}
                  title={item.observationNo}
                  subtitle={joinParts([item.department, item.officeName])}
                  meta={`Due ${formatDate(item.targetClosureDate)}`}
                  badge={item.isOverdue ? "OVERDUE" : item.status}
                  onOpen={() => onOpenObservation(item.observationId, "responses")}
                />
              ))
            ) : (
              <EmptyState text="No observations are waiting on a department response." />
            )}
          </div>
        </div>

        <div className="panel p-6">
          <div className="eyebrow">Closure Queue</div>
          <h3 className="section-title mt-2">Responses waiting for compliance review</h3>
          <div className="mt-5 space-y-3">
            {focus.pendingClosure.length ? (
              focus.pendingClosure.map((item) => (
                <QueueCard
                  key={item.observationId}
                  title={item.observationNo}
                  subtitle={joinParts([item.department, item.officeName])}
                  meta={item.latestResponse?.responseText || "No response text captured"}
                  badge={item.latestResponse?.closureStatus || "PENDING_REVIEW"}
                  onOpen={() => onOpenObservation(item.observationId, "closure")}
                />
              ))
            ) : (
              <EmptyState text="No responses are currently waiting for closure review." />
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[0.88fr_1.12fr]">
        <div className="panel p-6">
          <div className="eyebrow">Recent Activity</div>
          <h3 className="section-title mt-2">Latest department responses</h3>
          <div className="mt-5 space-y-4">
            {focus.recentResponses.length ? (
              focus.recentResponses.map((item) => (
                <div key={item.responseId} className="rounded-[22px] border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-cinder-900">{item.observationNo}</div>
                    <span className={statusTone(item.closureStatus)}>{titleCase(item.closureStatus)}</span>
                  </div>
                  <p className="mt-2 text-sm text-cinder-600">{item.responseText}</p>
                  <div className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-cinder-400">
                    {joinParts([item.department, item.responseBy, formatDate(item.responseDate)])}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState text="No response activity is available yet." />
            )}
          </div>
        </div>

        <div className="panel p-6">
          <div className="eyebrow">Department Pulse</div>
          <h3 className="section-title mt-2">Live report summary</h3>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {reports.map((row) => (
              <div key={row.department} className="rounded-[24px] border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold text-cinder-900">{row.department}</div>
                  <span className={statusTone(row.overdue ? "OVERDUE" : "CLOSED")}>
                    {row.overdue ? `${row.overdue} Overdue` : `${row.closed} Closed`}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                  <div className="rounded-2xl bg-white px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cinder-400">Total</div>
                    <div className="mt-2 text-lg font-semibold text-cinder-900">{row.total}</div>
                  </div>
                  <div className="rounded-2xl bg-white px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cinder-400">Open</div>
                    <div className="mt-2 text-lg font-semibold text-cinder-900">{row.open + row.responded}</div>
                  </div>
                  <div className="rounded-2xl bg-white px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cinder-400">Closed</div>
                    <div className="mt-2 text-lg font-semibold text-cinder-900">{row.closed}</div>
                  </div>
                  <div className="rounded-2xl bg-white px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cinder-400">Risk</div>
                    <div className="mt-2 text-lg font-semibold text-cinder-900">{row.overdue}</div>
                  </div>
                </div>
              </div>
            ))}
            {!reports.length ? <EmptyState text="No department summary is available." /> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function ObservationsScreen({
  capabilities,
  lookups,
  observations,
  allObservations,
  filters,
  onFilterChange,
  searchText,
  onSearchChange,
  selectedObservation,
  onOpenObservation,
  form,
  onFormChange,
  onSubmit,
  actionBusy,
}) {
  return (
    <div className="space-y-5">
      <section className="panel p-6">
        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr]">
          <div>
            <label className="field-label">Search</label>
            <input
              className="input-field"
              value={searchText}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search observation no, department, office, or summary"
            />
          </div>
          <div>
            <label className="field-label">Department</label>
            <select
              className="input-field"
              value={filters.department}
              onChange={(event) => onFilterChange((current) => ({ ...current, department: event.target.value }))}
            >
              <option value="ALL">All Departments</option>
              {lookups.departments.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Status</label>
            <select
              className="input-field"
              value={filters.status}
              onChange={(event) => onFilterChange((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="ALL">All Statuses</option>
              {lookups.observationStatuses.map((item) => (
                <option key={item} value={item}>
                  {titleCase(item)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Risk</label>
            <select
              className="input-field"
              value={filters.risk}
              onChange={(event) => onFilterChange((current) => ({ ...current, risk: event.target.value }))}
            >
              <option value="ALL">All Risk Levels</option>
              {lookups.riskLevels.map((item) => (
                <option key={item} value={item}>
                  {titleCase(item)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {capabilities.createObservation ? (
        <section className="panel p-6">
          <div className="eyebrow">Audit Register</div>
          <h3 className="section-title mt-2">Add audit observation</h3>
          <form className="mt-5 grid gap-4 xl:grid-cols-2" onSubmit={onSubmit}>
            <div>
              <label className="field-label">Audit Year</label>
              <input
                className="input-field"
                type="number"
                value={form.auditYear}
                onChange={(event) =>
                  onFormChange((current) => ({ ...current, auditYear: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="field-label">Department</label>
              <select
                className="input-field"
                value={form.department}
                onChange={(event) =>
                  onFormChange((current) => ({ ...current, department: event.target.value }))
                }
              >
                <option value="">Select department</option>
                {lookups.departments.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Office</label>
              <select
                className="input-field"
                value={form.officeId}
                onChange={(event) =>
                  onFormChange((current) => ({ ...current, officeId: event.target.value }))
                }
              >
                <option value="">Select office</option>
                {lookups.offices.map((item) => (
                  <option key={item.officeId} value={item.officeId}>
                    {item.officeName} ({titleCase(item.officeType)})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Risk Level</label>
              <select
                className="input-field"
                value={form.riskLevel}
                onChange={(event) =>
                  onFormChange((current) => ({ ...current, riskLevel: event.target.value }))
                }
              >
                {lookups.riskLevels.map((item) => (
                  <option key={item} value={item}>
                    {titleCase(item)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Observation Date</label>
              <input
                className="input-field"
                type="date"
                value={form.observationDate}
                onChange={(event) =>
                  onFormChange((current) => ({ ...current, observationDate: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="field-label">Target Closure Date</label>
              <input
                className="input-field"
                type="date"
                value={form.targetClosureDate}
                onChange={(event) =>
                  onFormChange((current) => ({
                    ...current,
                    targetClosureDate: event.target.value,
                  }))
                }
              />
            </div>
            <div className="xl:col-span-2">
              <label className="field-label">Observation Summary</label>
              <textarea
                className="textarea-field"
                value={form.observationSummary}
                onChange={(event) =>
                  onFormChange((current) => ({
                    ...current,
                    observationSummary: event.target.value,
                  }))
                }
                placeholder="Enter the control gap, the impact, and the expected corrective action."
              />
            </div>
            <div className="xl:col-span-2 flex justify-end">
              <button type="submit" className="btn-primary" disabled={actionBusy === "create"}>
                {actionBusy === "create" ? "Saving..." : "Submit Observation"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="panel p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="eyebrow">Live Register</div>
              <h3 className="section-title mt-2">Audit observations</h3>
            </div>
            <div className="text-sm font-semibold text-cinder-500">
              {observations.length} of {allObservations.length} visible
            </div>
          </div>

          <div className="table-shell">
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse">
                <thead className="bg-cinder-900 text-left text-xs uppercase tracking-[0.18em] text-white">
                  <tr>
                    <th className="table-cell text-white">Observation</th>
                    <th className="table-cell text-white">Department</th>
                    <th className="table-cell text-white">Due Date</th>
                    <th className="table-cell text-white">Risk</th>
                    <th className="table-cell text-white">Status</th>
                    <th className="table-cell text-white">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {observations.map((item) => (
                    <tr key={item.observationId} className="border-t border-slate-200">
                      <td className="table-cell">
                        <div className="font-semibold text-cinder-900">{item.observationNo}</div>
                        <div className="mt-1 text-xs uppercase tracking-[0.18em] text-cinder-400">
                          {item.officeName || "Unassigned"}
                        </div>
                        <p className="mt-2 max-w-xs text-sm text-cinder-600">{item.observationSummary}</p>
                      </td>
                      <td className="table-cell">{item.department}</td>
                      <td className="table-cell">{formatDate(item.targetClosureDate)}</td>
                      <td className="table-cell">
                        <span className={statusTone(item.riskLevel)}>{titleCase(item.riskLevel)}</span>
                      </td>
                      <td className="table-cell">
                        <div className="flex flex-col gap-2">
                          <span className={statusTone(item.isOverdue ? "OVERDUE" : item.status)}>
                            {item.isOverdue ? "Overdue" : titleCase(item.status)}
                          </span>
                          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-cinder-400">
                            {item.progressStage}
                          </span>
                        </div>
                      </td>
                      <td className="table-cell">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => onOpenObservation(item.observationId, "observations")}
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!observations.length ? (
                    <tr>
                      <td className="table-cell text-cinder-500" colSpan="6">
                        No observations match the current filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="panel p-6">
          <div className="eyebrow">Selected Detail</div>
          <h3 className="section-title mt-2">{selectedObservation?.observationNo || "Choose an observation"}</h3>
          {selectedObservation ? (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className={statusTone(selectedObservation.status)}>
                  {titleCase(selectedObservation.status)}
                </span>
                <span className={statusTone(selectedObservation.riskLevel)}>
                  {titleCase(selectedObservation.riskLevel)}
                </span>
                {selectedObservation.isOverdue ? (
                  <span className={statusTone("OVERDUE")}>Overdue</span>
                ) : null}
              </div>
              <div className="mt-5 space-y-4 text-sm text-cinder-600">
                <div>
                  <div className="field-label">Department</div>
                  <div>{selectedObservation.department}</div>
                </div>
                <div>
                  <div className="field-label">Office</div>
                  <div>{selectedObservation.officeName || "Unassigned"}</div>
                </div>
                <div>
                  <div className="field-label">Observation Summary</div>
                  <div className="rounded-[22px] bg-slate-50 p-4 leading-7">
                    {selectedObservation.observationSummary}
                  </div>
                </div>
                <div>
                  <div className="field-label">Response Timeline</div>
                  <div className="space-y-3">
                    {selectedObservation.responses.length ? (
                      selectedObservation.responses.map((response) => (
                        <div key={response.responseId} className="rounded-[22px] border border-slate-200 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="font-semibold text-cinder-900">{response.responseBy}</div>
                            <span className={statusTone(response.closureStatus)}>
                              {titleCase(response.closureStatus)}
                            </span>
                          </div>
                          <p className="mt-2">{response.responseText}</p>
                          <p className="mt-2 text-cinder-500">
                            Action: {response.actionTaken || "No action details recorded"}
                          </p>
                          <div className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-cinder-400">
                            {formatDate(response.responseDate)}
                          </div>
                        </div>
                      ))
                    ) : (
                      <EmptyState text="No response history has been recorded yet." />
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <EmptyState text="Select an observation from the table to inspect its full timeline." />
          )}
        </div>
      </section>
    </div>
  );
}

function ResponsesScreen({ observations, focus, selectedObservation, form, onFormChange, onSubmit, onOpenObservation, actionBusy }) {
  const candidates = observations.filter((item) => item.status !== "CLOSED");

  return (
    <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
      <section className="space-y-5">
        <div className="panel p-6">
          <div className="eyebrow">Response Queue</div>
          <h3 className="section-title mt-2">Observations ready for department action</h3>
          <div className="mt-5 space-y-3">
            {focus.pendingResponse.length ? (
              focus.pendingResponse.map((item) => (
                <QueueCard
                  key={item.observationId}
                  title={item.observationNo}
                  subtitle={`${item.department} • ${item.officeName}`}
                  meta={item.observationSummary}
                  badge={item.isOverdue ? "OVERDUE" : item.status}
                  onOpen={() => onOpenObservation(item.observationId, "responses")}
                />
              ))
            ) : (
              <EmptyState text="No open observations are waiting for a department response." />
            )}
          </div>
        </div>

        <div className="panel p-6">
          <div className="eyebrow">Latest Context</div>
          <h3 className="section-title mt-2">Selected observation detail</h3>
          {selectedObservation ? (
            <div className="mt-5 space-y-4 text-sm text-cinder-600">
              <div className="flex flex-wrap gap-2">
                <span className={statusTone(selectedObservation.status)}>
                  {titleCase(selectedObservation.status)}
                </span>
                <span className={statusTone(selectedObservation.riskLevel)}>
                  {titleCase(selectedObservation.riskLevel)}
                </span>
              </div>
              <div className="rounded-[24px] bg-slate-50 p-4">{selectedObservation.observationSummary}</div>
              {selectedObservation.latestResponse ? (
                <div className="rounded-[24px] border border-slate-200 p-4">
                  <div className="field-label">Latest response</div>
                  <div className="font-semibold text-cinder-900">
                    {selectedObservation.latestResponse.responseBy}
                  </div>
                  <p className="mt-2">{selectedObservation.latestResponse.responseText}</p>
                </div>
              ) : (
                <EmptyState text="No department response has been submitted yet." />
              )}
            </div>
          ) : (
            <EmptyState text="Choose an observation from the queue to respond." />
          )}
        </div>
      </section>

      <section className="panel p-6">
        <div className="eyebrow">Department Response</div>
        <h3 className="section-title mt-2">Submit corrective action update</h3>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="field-label">Observation</label>
            <select
              className="input-field"
              value={form.observationId}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, observationId: event.target.value }))
              }
            >
              <option value="">Select observation</option>
              {candidates.map((item) => (
                <option key={item.observationId} value={item.observationId}>
                  {item.observationNo} - {item.department}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Response Date</label>
            <input
              className="input-field"
              type="date"
              value={form.responseDate}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, responseDate: event.target.value }))
              }
            />
          </div>
          <div>
            <label className="field-label">Response / Action Taken</label>
            <textarea
              className="textarea-field"
              value={form.responseText}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, responseText: event.target.value }))
              }
              placeholder="Describe the departmental response."
            />
          </div>
          <div>
            <label className="field-label">Corrective Action</label>
            <textarea
              className="textarea-field"
              value={form.actionTaken}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, actionTaken: event.target.value }))
              }
              placeholder="Describe what was changed or remediated."
            />
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={actionBusy === "response"}>
              {actionBusy === "response" ? "Submitting..." : "Submit Response"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ClosureScreen({ observations, focus, selectedObservation, form, onFormChange, onSubmit, onOpenObservation, actionBusy }) {
  const queue = observations.filter((item) => item.latestResponse?.closureStatus === "PENDING_REVIEW");

  return (
    <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
      <section className="panel p-6">
        <div className="eyebrow">Compliance Queue</div>
        <h3 className="section-title mt-2">Review and close observations</h3>
        <div className="mt-5 space-y-3">
          {queue.length ? (
            queue.map((item) => (
              <QueueCard
                key={item.observationId}
                title={item.observationNo}
                subtitle={`${item.department} • ${item.officeName}`}
                meta={item.latestResponse?.actionTaken || item.observationSummary}
                badge={item.latestResponse?.closureStatus || "PENDING_REVIEW"}
                onOpen={() => onOpenObservation(item.observationId, "closure")}
              />
            ))
          ) : (
            <EmptyState text="No responses are waiting for closure verification." />
          )}
        </div>

        {selectedObservation ? (
          <div className="mt-6 rounded-[24px] bg-slate-50 p-5">
            <div className="field-label">Selected observation</div>
            <div className="text-lg font-semibold text-cinder-900">{selectedObservation.observationNo}</div>
            <p className="mt-2 text-sm leading-7 text-cinder-600">{selectedObservation.observationSummary}</p>
          </div>
        ) : null}
      </section>

      <section className="panel p-6">
        <div className="eyebrow">Compliance Closure</div>
        <h3 className="section-title mt-2">Accept closure or reopen for more action</h3>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="field-label">Observation</label>
            <select
              className="input-field"
              value={form.observationId}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, observationId: event.target.value }))
              }
            >
              <option value="">Select observation</option>
              {queue.map((item) => (
                <option key={item.observationId} value={item.observationId}>
                  {item.observationNo} - {item.department}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="field-label">Decision</label>
              <select
                className="input-field"
                value={form.decision}
                onChange={(event) =>
                  onFormChange((current) => ({ ...current, decision: event.target.value }))
                }
              >
                <option value="ACCEPTED">Accept Closure</option>
                <option value="REOPENED">Reopen Observation</option>
              </select>
            </div>
            <div>
              <label className="field-label">Decision Date</label>
              <input
                className="input-field"
                type="date"
                value={form.responseDate}
                onChange={(event) =>
                  onFormChange((current) => ({ ...current, responseDate: event.target.value }))
                }
              />
            </div>
          </div>
          <div>
            <label className="field-label">Verification Note</label>
            <textarea
              className="textarea-field"
              value={form.note}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, note: event.target.value }))
              }
              placeholder="Record the verification decision or the reason for reopening."
            />
          </div>
          <div>
            <label className="field-label">Reviewer Action</label>
            <textarea
              className="textarea-field"
              value={form.actionTaken}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, actionTaken: event.target.value }))
              }
              placeholder="Capture the compliance review action."
            />
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={actionBusy === "closure"}>
              {actionBusy === "closure" ? "Saving..." : "Save Closure Decision"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ReportsScreen({ observations, filters, onFilterChange, reportRows, summary }) {
  return (
    <div className="space-y-5">
      <section className="panel p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="eyebrow">Audit Reports</div>
            <h3 className="section-title mt-2">Department-wise live report preview</h3>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:min-w-[520px]">
            <div>
              <label className="field-label">Department</label>
              <select
                className="input-field"
                value={filters.department}
                onChange={(event) =>
                  onFilterChange((current) => ({ ...current, department: event.target.value }))
                }
              >
                <option value="ALL">All Departments</option>
                {[...new Set(observations.map((item) => item.department))].filter(Boolean).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Status</label>
              <select
                className="input-field"
                value={filters.status}
                onChange={(event) =>
                  onFilterChange((current) => ({ ...current, status: event.target.value }))
                }
              >
                <option value="ALL">All Statuses</option>
                <option value="OPEN">Open</option>
                <option value="RESPONDED">Responded</option>
                <option value="CLOSED">Closed</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Reported Scope" value={summary.total} accent="from-cinder-900 to-cinder-700" />
        <MetricCard title="Closed" value={summary.closed} accent="from-pine-700 to-pine-500" />
        <MetricCard title="Responded" value={summary.responded} accent="from-cinder-600 to-slate-500" />
        <MetricCard title="Overdue" value={summary.overdue} accent="from-signal-500 to-rose-400" />
      </section>

      <section className="panel p-6">
        <div className="table-shell">
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse">
              <thead className="bg-cinder-900 text-left text-xs uppercase tracking-[0.18em] text-white">
                <tr>
                  <th className="table-cell text-white">Department</th>
                  <th className="table-cell text-white">Total</th>
                  <th className="table-cell text-white">Open</th>
                  <th className="table-cell text-white">Responded</th>
                  <th className="table-cell text-white">Closed</th>
                  <th className="table-cell text-white">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.map((row) => (
                  <tr key={row.department} className="border-t border-slate-200">
                    <td className="table-cell font-semibold text-cinder-900">{row.department}</td>
                    <td className="table-cell">{row.total}</td>
                    <td className="table-cell">{row.open}</td>
                    <td className="table-cell">{row.responded}</td>
                    <td className="table-cell">{row.closed}</td>
                    <td className="table-cell">{row.overdue}</td>
                  </tr>
                ))}
                {!reportRows.length ? (
                  <tr>
                    <td className="table-cell text-cinder-500" colSpan="6">
                      No report rows match the current filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function MetricCard({ title, value, accent }) {
  return (
    <div className={`rounded-[28px] bg-gradient-to-br ${accent} p-5 text-white shadow-float`}>
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/64">{title}</div>
      <div className="mt-6 text-4xl font-semibold">{value}</div>
    </div>
  );
}

function QueueCard({ title, subtitle, meta, badge, onOpen }) {
  return (
    <button
      type="button"
      className="w-full rounded-[24px] border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-cinder-300 hover:bg-white"
      onClick={onOpen}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-cinder-900">{title}</div>
          <div className="mt-1 text-xs font-semibold uppercase tracking-[0.18em] text-cinder-400">
            {subtitle}
          </div>
        </div>
        <span className={statusTone(badge)}>{titleCase(badge)}</span>
      </div>
      <div className="mt-3 text-sm leading-6 text-cinder-600">{meta}</div>
    </button>
  );
}

function EmptyState({ text }) {
  return (
    <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-cinder-500">
      {text}
    </div>
  );
}

export default App;
