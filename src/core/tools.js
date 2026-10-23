// The AI-facing tools, shared by the MCP server and `mpr call <tool> '<json>'` (the shell route).
// Six tools: setup folds into invite/accept, close and the file list into inbox and thread, contacts and updates into doctor.
export function toolTable(mpr) {
  return {
    mpr_send: (a) => mpr.send(a),
    mpr_inbox: (a) => mpr.inbox(a),
    mpr_invite: (a) => mpr.invite(a),
    mpr_accept_invite: (a) => mpr.acceptInvite(a),
    mpr_thread: (a) => mpr.thread(a),
    mpr_doctor: (a) => mpr.doctorTool(a),
  };
}

// Names from 2.0.0–2.0.4, still accepted by `mpr call` (not listed): older invites and AIs use them.
export function legacyTools(mpr) {
  return {
    mpr_check_inbox: () => mpr.checkInbox(),
    mpr_wait: (a = {}) => mpr.wait({ thread: a.thread, timeout_sec: a.timeout_sec ?? a.wait_sec }),
    mpr_close: (a) => mpr.close(a),
    mpr_files: (a) => mpr.files(a),
    mpr_contacts: () => mpr.listContacts(),
    mpr_remove_contact: (a) => mpr.removeContact(a),
    mpr_setup: (a) => mpr.setup(a),
    mpr_update: () => mpr.update(),
  };
}

// Everyday tools, pre-approved at install so two AIs can talk without permission prompts.
export const TOOLS = Object.keys(toolTable({}));
// The background helper runs with nobody watching: it may read and answer notes, nothing else.
export const AUTOPILOT_TOOLS = ["mpr_inbox", "mpr_send", "mpr_thread"];
