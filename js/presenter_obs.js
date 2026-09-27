// OBS WebSocket v5. Runs only in the local controls window. Credentials never
// enter the Planéir window, a URL, storage, or the local HTTP server.
export async function obsAuthentication(password, { salt, challenge }) {
  const digest = async text => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))));
  return digest((await digest(password + salt)) + challenge);
}

export function createOBSConnection({ Socket = globalThis.WebSocket, onDisconnect = () => {}, onRecordState = () => {}, timeout = 6000 } = {}) {
  let socket, identified = false, sequence = 0, connectReject;
  const pending = new Map();
  const rejectPending = error => {
    identified = false; connectReject?.(error); connectReject = null;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const api = {
    async connect(password, port = 4455) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Enter the OBS WebSocket port, usually 4455.');
      api.disconnect();
      const connection = new Socket(`ws://127.0.0.1:${port}`, 'obswebsocket.json'); socket = connection;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('OBS connection timed out. Enable its WebSocket server and check the port.')); connection.close(); }, timeout);
        connectReject = error => { clearTimeout(timer); reject(error); };
        connection.addEventListener('message', async event => {
          if (socket !== connection) return;
          try {
            const { op, d } = JSON.parse(event.data);
            if (op === 0) {
              // Require authentication rather than silently using an unprotected server.
              if (!d.authentication) throw new Error('Enable authentication in OBS → Tools → WebSocket Server Settings.');
              const authentication = await obsAuthentication(password, d.authentication); password = '';
              if (socket !== connection || connection.readyState !== 1) return;
              connection.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 64, authentication } }));
            } else if (op === 2) {
              clearTimeout(timer); connectReject = null; identified = true; resolve();
            } else if (op === 7) {
              const request = pending.get(d.requestId); if (!request) return;
              pending.delete(d.requestId); clearTimeout(request.timer);
              if (d.requestStatus?.result) request.resolve(d.responseData || {});
              else request.reject(new Error(`OBS ${request.type}: ${d.requestStatus?.comment || 'request failed'} (${d.requestStatus?.code || 'unknown'}).`));
            } else if (op === 5 && d.eventType === 'RecordStateChanged') onRecordState(d.eventData);
          } catch (error) { rejectPending(error); connection.close(); }
        });
        connection.addEventListener('close', event => {
          password = ''; clearTimeout(timer); if (socket !== connection) return;
          const error = new Error(event.code === 4009 ? 'OBS password was rejected. Copy it from WebSocket Server Settings.' : 'OBS connection lost. Recording status is unknown; check OBS or reconnect.');
          rejectPending(error); onDisconnect(error);
        });
        connection.addEventListener('error', () => {
          if (socket === connection) { rejectPending(new Error('Cannot reach OBS. Open OBS and enable its WebSocket server.')); connection.close(); }
        });
      });
      return api.status();
    },
    request(type) {
      if (!['GetRecordStatus', 'StartRecord', 'StopRecord'].includes(type)) return Promise.reject(new Error('Unsupported OBS command.'));
      if (!identified || socket?.readyState !== 1) return Promise.reject(new Error('Connect to OBS first.'));
      return new Promise((resolve, reject) => {
        const requestId = String(++sequence);
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`OBS did not confirm ${type}. Its recording status is unknown; reconnect before continuing.`)); }, timeout);
        pending.set(requestId, { resolve, reject, timer, type });
        socket.send(JSON.stringify({ op: 6, d: { requestType: type, requestId } }));
      });
    },
    status: () => api.request('GetRecordStatus'),
    disconnect() { const previous = socket; socket = null; rejectPending(new Error('OBS disconnected.')); previous?.close(); },
    get connected() { return identified; }
  };
  return api;
}
