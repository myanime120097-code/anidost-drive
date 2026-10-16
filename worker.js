// ============================================================
// Anime Drive API — Cloudflare Worker + KV
// Worker name : anidost-drive
// KV binding  : anidost-drive
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

function getKV(env) {
  return env["anidost-drive"];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function validFileName(name) {
  return /^anime_\d+\.js$/.test(name);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const KV = getKV(env);

    // ---------- CORS preflight ----------
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ============================================================
    // PUBLIC ROUTES (auth ছাড়া)
    // ============================================================

    // Health check
    if ((path === "/" || path === "/health") && request.method === "GET") {
      return json({
        ok: true,
        service: "Anime Drive API",
        worker: "anidost-drive",
        time: new Date().toISOString(),
      });
    }

    // GET /js/:name → JS content (script tag এর জন্য)
    const jsMatch = path.match(/^\/js\/(.+)$/);
    if (jsMatch && request.method === "GET") {
      const name = decodeURIComponent(jsMatch[1]);
      if (!validFileName(name)) {
        return new Response("// invalid file: " + name, {
          status: 400,
          headers: { "Content-Type": "application/javascript; charset=utf-8", ...CORS },
        });
      }
      const content = await KV.get(name);
      if (content === null) {
        return new Response("// not found: " + name, {
          status: 404,
          headers: { "Content-Type": "application/javascript; charset=utf-8", ...CORS },
        });
      }
      return new Response(content, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          ...CORS,
        },
      });
    }

    // GET /list-public → file names (frontend এর জন্য)
    if (path === "/list-public" && request.method === "GET") {
      const list = await KV.list({ prefix: "anime_" });
      const files = list.keys
        .filter((k) => validFileName(k.name))
        .map((k) => ({ name: k.name }))
        .sort((a, b) => {
          const na = parseInt((a.name.match(/_(\d+)\.js/) || [])[1] || "0", 10);
          const nb = parseInt((b.name.match(/_(\d+)\.js/) || [])[1] || "0", 10);
          return na - nb;
        });
      return json({ files });
    }

    // ============================================================
    // AUTH REQUIRED ROUTES
    // ============================================================
    const key = request.headers.get("X-API-Key");
    if (!env.API_KEY || key !== env.API_KEY) {
      return err("Unauthorized", 401);
    }

    try {
      // GET /list → সব file names
      if (path === "/list" && request.method === "GET") {
        const list = await KV.list({ prefix: "anime_" });
        const files = list.keys
          .filter((k) => validFileName(k.name))
          .map((k) => ({ name: k.name }));
        return json({ files });
      }

      // /file/:name
      const fileMatch = path.match(/^\/file\/(.+)$/);
      if (fileMatch) {
        const name = decodeURIComponent(fileMatch[1]);
        if (!validFileName(name)) return err("Invalid file name", 400);

        // GET
        if (request.method === "GET") {
          const content = await KV.get(name);
          if (content === null) return err("Not found", 404);
          return json({ content });
        }

        // PUT
        if (request.method === "PUT") {
          let body;
          try {
            body = await request.json();
          } catch {
            return err("Invalid JSON body", 400);
          }
          if (typeof body.content !== "string") {
            return err("Missing 'content' string", 400);
          }
          if (body.content.length > 5 * 1024 * 1024) {
            return err("Content too large (max 5MB)", 413);
          }
          await KV.put(name, body.content);
          return json({ ok: true, name, size: body.content.length });
        }

        // DELETE
        if (request.method === "DELETE") {
          await KV.delete(name);
          return json({ ok: true, deleted: name });
        }
      }

      return err("Not found", 404);
    } catch (e) {
      return err("Server error: " + e.message, 500);
    }
  },
};
