// The AI-facing tools, shared by the MCP server and `mpr call <tool> '<json>'` (the shell route).
export function toolTable(mpr) {
  return {
    mpr_setup: (a) => mpr.setup(a),
    mpr_invite: (a) => mpr.invite(a),
    mpr_accept_invite: (a) => mpr.acceptInvite(a),
    mpr_send: (a) => mpr.send(a),
    mpr_check_inbox: () => mpr.checkInbox(),
    mpr_wait: (a) => mpr.wait(a),
    mpr_thread: (a) => mpr.thread(a),
    mpr_close: (a) => mpr.close(a),
    mpr_files: (a) => mpr.files(a),
    mpr_contacts: () => mpr.listContacts(),
    mpr_remove_contact: (a) => mpr.removeContact(a),
    mpr_doctor: () => mpr.doctor(),
    mpr_update: () => mpr.update(),
  };
}

// Everyday tools, pre-approved at install so two AIs can talk without permission prompts.
export const TOOLS = Object.keys(toolTable({}));
// The background helper runs with nobody watching: it may read and answer notes, nothing else.
export const AUTOPILOT_TOOLS = ["mpr_check_inbox", "mpr_send", "mpr_thread", "mpr_close", "mpr_files", "mpr_contacts"];
