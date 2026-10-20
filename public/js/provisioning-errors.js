(function (root) {
  'use strict';
  async function readProvisioningError(error, data, operation = 'registration') {
    const editing = operation === 'edit';
    let body = data;
    const response = error?.context;
    if (!body?.error && response && typeof response.json === 'function') {
      try { body = await (response.clone ? response.clone() : response).json(); } catch (_) {}
    }
    if (typeof body?.error === 'string' && body.error.trim()) return body.error.trim().slice(0, 400);
    const status = response?.status || error?.status;
    if (status === 401) return editing ? 'Your session expired. Sign in again before editing staff.' : 'Your session expired. Sign in again before registering staff.';
    if (status === 403) return editing ? 'Your account cannot edit staff. Sign in with a desktop administrator account.' : 'Your account cannot register staff. Sign in with a desktop administrator account.';
    if (status === 404) return editing ? 'The staff editing service is unavailable. Deploy the update-staff server function.' : 'The staff registration service is unavailable. Its server function needs deployment.';
    if (status === 409) return editing ? 'This account changed or these sign-in details are already in use. Refresh the directory and review your changes.' : 'An account already uses these details. Edit or restore the existing staff account.';
    if (status >= 500) return editing ? 'The staff editing service could not complete the request. Refresh before retrying.' : 'The staff registration service could not complete the request. Retry after it reconnects.';
    return editing ? 'Staff changes could not be confirmed. Check your connection and refresh before retrying.' : 'Staff registration could not reach the service. Check your connection and retry.';
  }
  if (typeof module === 'object' && module.exports) module.exports = { readProvisioningError };
  else root.EcoTrackProvisioningErrors = { readProvisioningError };
})(typeof globalThis === 'object' ? globalThis : this);
