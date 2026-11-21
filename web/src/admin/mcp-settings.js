const base = "/api/v1/settings/mcp";
const byId = (id) => document.getElementById(`mcp-${id}`);
const enabled = byId("enabled");
const stateBadge = byId("state");
const endpoint = byId("endpoint");
const endpointNote = byId("endpoint-note");
const tokensNote = byId("tokens-note");
const tokenList = byId("tokens");
const status = byId("status");
const createDialog = byId("create");
const createName = byId("name");
const createVaults = byId("create-vaults");
const createToggleAll = byId("create-toggle-all");
const createHint = byId("create-hint");
const createError = byId("create-error");
const createSubmit = byId("create-submit");
const editDialog = byId("edit");
const editTokenLabel = byId("edit-token");
const editVaults = byId("edit-vaults");
const editToggleAll = byId("edit-toggle-all");
const editHint = byId("edit-hint");
const editError = byId("edit-error");
const editSubmit = byId("edit-submit");
const createdDialog = byId("created");
const revokeDialog = byId("revoke");
const secret = byId("secret");

let current;
let pending = false;
let savingEnabled;
let retry;
let tokenToEdit;
let tokenToRevoke;

class SettingsError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function request(path = "", method = "GET", body) {
  const options = { method, cache: "no-store", credentials: "same-origin" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(base + path, options);
  if (response.status === 204) return;
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data === undefined) {
    throw new SettingsError(data?.error ?? "Settings are unavailable.", response.status);
  }
  return data;
}

function setError(message = "", action) {
  byId("error").textContent = message;
  byId("recovery").hidden = message === "";
  byId("retry").hidden = action === undefined;
  retry = action;
}

function vaultNamesById() {
  return new Map((current?.vaults ?? []).map((vault) => [vault.id, vault.name]));
}

function selectedVaultIds(container) {
  return Array.from(container.querySelectorAll("input:checked"), (input) => input.value);
}

function sameVaultSelection(left, right) {
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((id) => set.has(id));
}

function vaultOption(vault, checked, onChange) {
  const label = document.createElement("label");
  label.className = "mcp-vault-option";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = vault.id;
  input.checked = checked;
  input.onchange = onChange;
  const text = document.createElement("span");
  text.textContent = vault.name;
  label.append(input, text);
  return label;
}

function populateVaultPicker(container, selectedIds, onChange) {
  const selected = new Set(selectedIds);
  container.replaceChildren(
    ...(current?.vaults ?? []).map((vault) => vaultOption(vault, selected.has(vault.id), onChange)),
  );
}

function updateToggleAllButton(button, container) {
  const inputs = Array.from(container.querySelectorAll("input[type='checkbox']"));
  if (inputs.length < 2) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const allChecked = inputs.every((input) => input.checked);
  button.textContent = allChecked ? "Clear" : "Select all";
}

function toggleAllVaults(container, onChange) {
  const inputs = Array.from(container.querySelectorAll("input[type='checkbox']"));
  const allChecked = inputs.every((input) => input.checked);
  for (const input of inputs) input.checked = !allChecked;
  onChange();
}

function selectionCountText(count, emptyMessage) {
  if (count === 0) return emptyMessage;
  return count === 1 ? "1 vault selected" : `${count} vaults selected`;
}

function updateCreateState() {
  const selected = selectedVaultIds(createVaults);
  const hasName = createName.value.trim().length > 0;
  updateToggleAllButton(createToggleAll, createVaults);
  createHint.textContent = selectionCountText(selected.length, "Select at least one vault.");
  createSubmit.disabled = pending || !hasName || selected.length === 0;
}

function updateEditState() {
  const selected = selectedVaultIds(editVaults);
  updateToggleAllButton(editToggleAll, editVaults);
  editHint.textContent = selectionCountText(
    selected.length,
    "Select at least one vault, or revoke this token.",
  );
  const unchanged = tokenToEdit !== undefined && sameVaultSelection(selected, tokenToEdit.vaults);
  editSubmit.disabled = pending || selected.length === 0 || unchanged;
}

function openEditDialog(token) {
  if (!current || pending) return;
  tokenToEdit = token;
  editTokenLabel.textContent = `${token.name} · ••••${token.id.slice(-8)}`;
  populateVaultPicker(editVaults, token.vaults, () => {
    editError.hidden = true;
    updateEditState();
  });
  editError.hidden = true;
  updateEditState();
  editDialog.showModal();
}

function tokenRow(token, names) {
  const row = document.createElement("li");
  row.className = token.revoked_at === null ? "mcp-token-row" : "mcp-token-row mcp-token-revoked";

  const info = document.createElement("div");
  info.className = "mcp-token-info";

  const title = document.createElement("strong");
  title.className = "mcp-token-name";
  title.textContent = token.name;

  const vaultNames = token.vaults
    .map((id) => names.get(id))
    .filter((name) => name !== undefined);
  const vaultSummary = document.createElement("small");
  vaultSummary.className = "mcp-token-vaults";
  vaultSummary.textContent = vaultNames.length > 0 ? vaultNames.join(", ") : "No vaults assigned";

  const dates = document.createElement("small");
  dates.className = "mcp-token-meta";
  const formatDate = (seconds) => new Date(seconds * 1000).toLocaleDateString();
  const used = token.last_used_at === null ? "" : ` · Used ${formatDate(token.last_used_at)}`;
  const revoked = token.revoked_at === null ? "" : " · Revoked";
  dates.textContent = `••••${token.id.slice(-8)} · Created ${formatDate(token.created_at)}${used}${revoked}`;

  info.append(title, vaultSummary, dates);
  row.append(info);

  if (token.revoked_at === null) {
    const actions = document.createElement("div");
    actions.className = "mcp-token-actions";

    const editButton = document.createElement("button");
    editButton.className = "mb-button mb-quiet mb-small";
    editButton.type = "button";
    editButton.textContent = "Edit vaults";
    editButton.dataset.tokenId = token.id;
    editButton.setAttribute("aria-label", `Edit vaults for ${token.name}`);
    editButton.disabled = pending || !current.endpoint || current.vaults.length === 0;
    editButton.onclick = () => openEditDialog(token);

    const revokeButton = document.createElement("button");
    revokeButton.className = "mb-button mb-quiet mb-small";
    revokeButton.type = "button";
    revokeButton.textContent = "Revoke";
    revokeButton.setAttribute("aria-label", `Revoke ${token.name}`);
    revokeButton.disabled = pending;
    revokeButton.onclick = () => {
      tokenToRevoke = token;
      byId("revoke-name").textContent = token.name;
      revokeDialog.returnValue = "cancel";
      revokeDialog.showModal();
    };

    actions.append(editButton, revokeButton);
    row.append(actions);
  }
  return row;
}

function render() {
  if (!current) return;
  const hasEndpoint = Boolean(current.endpoint);
  const isEnabled = savingEnabled !== undefined ? savingEnabled : current.enabled;
  endpoint.value = current.endpoint ?? "";
  endpoint.placeholder = "Endpoint unavailable";
  byId("copy-url").disabled = !hasEndpoint;
  enabled.checked = isEnabled;
  enabled.disabled = pending || !hasEndpoint;

  stateBadge.hidden = !hasEndpoint;
  stateBadge.dataset.state = isEnabled ? "online" : "offline";
  stateBadge.textContent = isEnabled ? "Enabled" : "Off";

  if (!hasEndpoint) {
    endpointNote.textContent = "MCP listener is not configured in server.toml.";
    endpointNote.hidden = false;
  } else if (!isEnabled) {
    endpointNote.textContent = "Clients cannot connect until MCP access is enabled.";
    endpointNote.hidden = false;
  } else {
    endpointNote.hidden = true;
  }

  const hasVaults = current.vaults.length > 0;
  byId("new-token").disabled = pending || !hasEndpoint || !hasVaults;
  if (hasEndpoint && !hasVaults) {
    tokensNote.textContent = "Register a vault you can access before creating a token.";
    tokensNote.hidden = false;
  } else if (hasEndpoint && current.tokens.length === 0) {
    tokensNote.textContent = "No access tokens yet. Create a token and choose which vaults it can read.";
    tokensNote.hidden = false;
  } else {
    tokensNote.hidden = true;
  }

  const names = vaultNamesById();
  tokenList.replaceChildren(...current.tokens.map((token) => tokenRow(token, names)));
}

async function load() {
  try {
    current = await request();
    setError();
    render();
  } catch (error) {
    if (error.statusCode === 404 && createdDialog.open) {
      clearSecret();
      createdDialog.close();
    }
    setError(error.message, load);
  }
}

async function saveEnabled(nextEnabled) {
  if (pending || !current) return;
  pending = true;
  savingEnabled = nextEnabled;
  status.textContent = "Saving…";
  setError();
  render();
  try {
    current = await request("", "PATCH", { revision: current.revision, enabled: nextEnabled });
    status.textContent = "Saved";
  } catch (error) {
    status.textContent = "";
    try {
      current = await request();
      setError(
        error.statusCode === 409 ? error.message : "Couldn’t confirm the change.",
        () => saveEnabled(nextEnabled),
      );
    } catch {
      setError("Couldn’t refresh Settings.", load);
    }
  } finally {
    pending = false;
    savingEnabled = undefined;
    render();
    enabled.focus();
  }
}

function copyLegacy(input) {
  const value = input.value;
  if (!value) return false;
  const previous = document.activeElement;
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange?.(0, value.length);
    if (document.execCommand("copy")) {
      if (previous instanceof HTMLElement && previous !== input) {
        previous.focus({ preventScroll: true });
      }
      return true;
    }
  } catch {
    // Fall through to a temporary textarea mounted inside the active dialog or body.
  }
  // why: some browsers refuse execCommand on readonly/url inputs, and showModal() makes
  // document.body inert, so the scratch field must live inside the open dialog when present.
  const host = input.closest("dialog") ?? document.body;
  const scratch = document.createElement("textarea");
  scratch.value = value;
  scratch.inputMode = "none";
  scratch.setAttribute("aria-hidden", "true");
  scratch.style.position = "fixed";
  scratch.style.top = "0";
  scratch.style.left = "0";
  scratch.style.opacity = "0";
  scratch.style.fontSize = "16px";
  host.append(scratch);
  try {
    scratch.focus({ preventScroll: true });
    scratch.select();
    scratch.setSelectionRange(0, value.length);
    const copied = document.execCommand("copy");
    if (copied && previous instanceof HTMLElement) {
      previous.focus({ preventScroll: true });
    }
    return copied;
  } catch {
    return false;
  } finally {
    scratch.value = "";
    scratch.remove();
  }
}

async function copy(input, message) {
  const value = input.value;
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      message.textContent = "Copied";
      return;
    } catch {
      // Fall back to execCommand when Clipboard API rejects (e.g. non-secure context or denied).
    }
  }
  if (copyLegacy(input)) {
    message.textContent = "Copied";
    return;
  }
  input.focus();
  input.select();
  message.textContent = "Copy the selected text.";
}

byId("copy-url").onclick = () => void copy(endpoint, status);
endpoint.onclick = () => void copy(endpoint, status);
enabled.onchange = () => void saveEnabled(enabled.checked);
byId("retry").onclick = () => void retry?.();

byId("new-token").onclick = () => {
  if (!current || current.vaults.length === 0) return;
  byId("create-form").reset();
  populateVaultPicker(createVaults, [], () => {
    createError.hidden = true;
    updateCreateState();
  });
  createError.hidden = true;
  updateCreateState();
  createDialog.showModal();
  createName.focus();
};

createName.oninput = () => {
  createError.hidden = true;
  updateCreateState();
};
createToggleAll.onclick = () => {
  toggleAllVaults(createVaults, () => {
    createError.hidden = true;
    updateCreateState();
  });
};
byId("cancel-create").onclick = () => createDialog.close();

byId("create-form").onsubmit = async (event) => {
  event.preventDefault();
  if (pending) return;
  const name = createName.value.trim();
  const vaults = selectedVaultIds(createVaults);
  if (!name || vaults.length === 0) {
    createError.textContent = !name ? "Enter a name." : "Select at least one vault.";
    createError.hidden = false;
    updateCreateState();
    return;
  }
  pending = true;
  createError.hidden = true;
  updateCreateState();
  try {
    const created = await request("/tokens", "POST", { name, vaults });
    // A completed response must not reopen an intentionally dismissed form.
    if (createDialog.open && !document.hidden) {
      createDialog.close();
      secret.value = created.secret;
      createdDialog.showModal();
    } else if (createDialog.open) {
      createDialog.close();
    }
    await load();
  } catch (error) {
    if (error.statusCode === 400) {
      createError.textContent = error.message;
      createError.hidden = false;
    } else {
      createDialog.close();
      await load();
      setError("Couldn’t confirm creation. Check the token list before trying again.");
    }
  } finally {
    pending = false;
    updateCreateState();
    render();
  }
};

editToggleAll.onclick = () => {
  toggleAllVaults(editVaults, () => {
    editError.hidden = true;
    updateEditState();
  });
};
byId("cancel-edit").onclick = () => editDialog.close();
editDialog.addEventListener("close", () => {
  tokenToEdit = undefined;
});

byId("edit-form").onsubmit = async (event) => {
  event.preventDefault();
  if (pending || !current || !tokenToEdit) return;
  const target = tokenToEdit;
  const vaults = selectedVaultIds(editVaults);
  if (vaults.length === 0) {
    editError.textContent = "Select at least one vault, or revoke this token.";
    editError.hidden = false;
    updateEditState();
    return;
  }
  pending = true;
  editError.hidden = true;
  updateEditState();
  try {
    current = await request(`/tokens/${encodeURIComponent(target.id)}`, "PATCH", {
      revision: current.revision,
      vaults,
    });
    editDialog.close();
    status.textContent = "Vaults updated";
    setError();
    render();
    const button = Array.from(tokenList.querySelectorAll("button[data-token-id]"))
      .find((entry) => entry.dataset.tokenId === target.id);
    button?.focus();
  } catch (error) {
    if (error.statusCode === 400) {
      editError.textContent = error.message;
      editError.hidden = false;
    } else {
      try {
        current = await request();
        render();
        const refreshed = current.tokens.find((token) => token.id === target.id);
        if (!refreshed || refreshed.revoked_at !== null) {
          editDialog.close();
          setError("Settings changed in another window.");
        } else if (error.statusCode === 409) {
          tokenToEdit = refreshed;
          populateVaultPicker(editVaults, refreshed.vaults, () => {
            editError.hidden = true;
            updateEditState();
          });
          editError.textContent = "Settings changed in another window. Review and save again.";
          editError.hidden = false;
        } else if (sameVaultSelection(vaults, refreshed.vaults)) {
          editDialog.close();
          status.textContent = "Vaults updated";
        } else {
          tokenToEdit = refreshed;
          editError.textContent = "Couldn’t confirm the change. Try saving again.";
          editError.hidden = false;
        }
      } catch {
        editError.textContent = "Couldn’t confirm the change. Try saving again.";
        editError.hidden = false;
      }
    }
  } finally {
    pending = false;
    if (editDialog.open) updateEditState();
    render();
  }
};

function clearSecret() {
  secret.value = "";
  byId("copy-status").textContent = "";
}

createdDialog.addEventListener("close", clearSecret);
createdDialog.addEventListener("cancel", clearSecret);
byId("done").onclick = () => {
  clearSecret();
  createdDialog.close();
};
byId("copy-token").onclick = () => void copy(secret, byId("copy-status"));
secret.onclick = () => void copy(secret, byId("copy-status"));

for (const dialog of [createDialog, editDialog, revokeDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

window.addEventListener("pagehide", () => {
  clearSecret();
  if (createdDialog.open) createdDialog.close();
  if (createDialog.open) createDialog.close();
  if (editDialog.open) editDialog.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void load();
});

revokeDialog.addEventListener("close", () => {
  if (revokeDialog.returnValue === "revoke" && tokenToRevoke) void revoke(tokenToRevoke);
  tokenToRevoke = undefined;
});

async function revoke(token) {
  if (pending) return;
  pending = true;
  setError();
  render();
  try {
    await request(`/tokens/${encodeURIComponent(token.id)}`, "DELETE");
    status.textContent = "Token revoked";
    await load();
  } catch {
    await load();
    setError("Couldn’t confirm revocation.", () => revoke(token));
  } finally {
    pending = false;
    render();
  }
}

void load();
