import { workspaceStatusCopy } from './copy.js';

// The future job transport supplies status events to this renderer. It does
// not poll, invent progress, or advance to a result on an elapsed timer.
export function renderWorkspaceStatus(host, status) {
  const copy = workspaceStatusCopy(status);
  host.querySelector('h1, h2').textContent = copy.title;
  host.querySelector('p').textContent = copy.body;
  host.setAttribute('aria-busy', String(['preparing', 'calculating', 'organising'].includes(status)));
}
