// The flasher's old address.
//
// Until 2026-11-06 this tool was CANary Flasher, at canary-flasher.stoatworks-labs.com,
// and flashed CANaries only. It is Stoatworks Flasher now, at flasher.stoatworks-labs.com,
// and flashes every device we make. Every request to the old address is sent there with
// its path and query intact, and with the CANary already chosen unless the link chose
// something else, so a bookmark or a link in a CANary manual lands where it meant to.
// The old site had no service worker, so there is none to retire.

const NEW_ORIGIN = "https://flasher.stoatworks-labs.com";

export default {
  fetch(request) {
    const url = new URL(request.url);
    const query = new URLSearchParams(url.search);
    if (url.pathname === "/" && !query.has("device")) query.set("device", "canary");
    const search = query.toString();
    return Response.redirect(NEW_ORIGIN + url.pathname + (search ? `?${search}` : ""), 301);
  },
};
