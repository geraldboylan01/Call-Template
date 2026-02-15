const STORAGE_KEY = 'call-template-session-v1';
const SESSION_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function normalizeModules(modules) {
  if (!Array.isArray(modules)) {
    return [];
  }

  return modules
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => ({
      id: item.id,
      createdAt: item.createdAt || nowIso(),
      updatedAt: item.updatedAt || item.createdAt || nowIso(),
      title: typeof item.title === 'string' ? item.title : '',
      notes: typeof item.notes === 'string' ? item.notes : ''
    }));
}

function normalizeOrder(order, modules) {
  const ids = new Set(modules.map((module) => module.id));
  const cleanOrder = Array.isArray(order)
    ? order.filter((id) => typeof id === 'string' && ids.has(id))
    : [];

  const seen = new Set(cleanOrder);
  for (const module of modules) {
    if (!seen.has(module.id)) {
      cleanOrder.push(module.id);
      seen.add(module.id);
    }
  }

  return cleanOrder;
}

export function createFreshSession() {
  const timestamp = nowIso();
  return {
    version: SESSION_VERSION,
    clientName: 'Client',
    createdAt: timestamp,
    updatedAt: timestamp,
    modules: [],
    order: [],
    activeModuleId: null
  };
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createFreshSession();
    }

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SESSION_VERSION) {
      return createFreshSession();
    }

    const modules = normalizeModules(parsed.modules);
    const order = normalizeOrder(parsed.order, modules);
    const activeModuleId = order.includes(parsed.activeModuleId)
      ? parsed.activeModuleId
      : order[0] || null;

    return {
      version: SESSION_VERSION,
      clientName: typeof parsed.clientName === 'string' && parsed.clientName.trim()
        ? parsed.clientName
        : 'Client',
      createdAt: parsed.createdAt || nowIso(),
      updatedAt: parsed.updatedAt || parsed.createdAt || nowIso(),
      modules,
      order,
      activeModuleId
    };
  } catch (_error) {
    return createFreshSession();
  }
}

export function createStateManager(delayMs = 300) {
  let timerId = null;

  function persist(session) {
    session.updatedAt = nowIso();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function saveNow(session) {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    persist(session);
  }

  function scheduleSave(session) {
    if (timerId) {
      clearTimeout(timerId);
    }

    timerId = window.setTimeout(() => {
      timerId = null;
      persist(session);
    }, delayMs);
  }

  function reset() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    localStorage.removeItem(STORAGE_KEY);
  }

  return {
    saveNow,
    scheduleSave,
    reset
  };
}

export function getModuleById(session, moduleId) {
  return session.modules.find((module) => module.id === moduleId) || null;
}

export function getOrderedModules(session) {
  const moduleById = new Map(session.modules.map((module) => [module.id, module]));
  return session.order
    .map((id) => moduleById.get(id))
    .filter(Boolean);
}

export function ensureActiveModule(session) {
  if (session.order.length === 0) {
    session.activeModuleId = null;
    return;
  }

  if (!session.order.includes(session.activeModuleId)) {
    session.activeModuleId = session.order[0];
  }
}

export function getStorageKey() {
  return STORAGE_KEY;
}
