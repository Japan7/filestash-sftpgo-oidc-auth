import "https://deno.land/std@0.223.0/dotenv/load.ts";
import { logger } from "https://deno.land/x/hono@v4.2.7/middleware.ts";
import { Hono } from "https://deno.land/x/hono@v4.2.7/mod.ts";

const FILESTASH_URL = Deno.env.get("FILESTASH_URL")!;
const FILESTASH_API_KEY = Deno.env.get("FILESTASH_API_KEY")!;
const API_PREFIX = Deno.env.get("API_PREFIX")!;

const OIDC_CONFIG_URL = Deno.env.get("OIDC_CONFIG_URL")!;
const OIDC_CLIENT_ID = Deno.env.get("OIDC_CLIENT_ID")!;
const OIDC_CLIENT_SECRET = Deno.env.get("OIDC_CLIENT_SECRET")!;

const SFTPGO_WEB_URL = Deno.env.get("SFTPGO_WEB_URL")!;
const SFTPGO_ADMIN_BASICAUTH = Deno.env.get("SFTPGO_ADMIN_BASICAUTH")!;

const SFTPGO_SFTP_HOST = Deno.env.get("SFTPGO_SFTP_HOST")!;
const SFTPGO_SFTP_PORT = Deno.env.get("SFTPGO_SFTP_PORT")!;
const PUBKEY_FILE = Deno.env.get("PUBKEY_FILE")!;
const PRIVKEY_FILE = Deno.env.get("PRIVKEY_FILE")!;

const PUBKEY = await Deno.readTextFile(PUBKEY_FILE);
const PRIVKEY = await Deno.readTextFile(PRIVKEY_FILE);

const FILESTASH_REDIRECT_URI = `${FILESTASH_URL}${API_PREFIX}/callback`;

const app = new Hono();

app.use("*", logger());

app.get("/login", (c) => {
  return c.redirect(`${API_PREFIX}/login`);
});

app.get(`${API_PREFIX}/login`, async (c) => {
  const config = await getOIDCConfig();
  const authUrl = new URL(config.authorization_endpoint);
  authUrl.searchParams.set("client_id", OIDC_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", FILESTASH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid profile groups");
  return c.redirect(authUrl.toString());
});

app.get(`${API_PREFIX}/callback`, async (c) => {
  const accessToken = await getOIDCAccessToken(c.req.query("code")!);
  console.debug(accessToken);
  const data = await getUserinfo(accessToken);
  console.debug(data);

  const { preferred_username: username, groups: oidc_groups } = data as {
    preferred_username: string;
    groups: string[];
  };

  const groups = oidc_groups.map((g: string) => ({
    name: g.replace("discord-", ""),
    type: 2,
  }));

  const apiToken = await createToken();
  const user = await findUser(apiToken, username);
  console.debug(user);

  if (!user) {
    await createUser(apiToken, username, groups);
  } else {
    await updateUser(apiToken, user, groups);
  }

  const setCookie = await createFilestashSession(username);
  c.res.headers.set("Set-Cookie", setCookie);
  return c.redirect("/");
});

let oidcConfig: {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};
async function getOIDCConfig() {
  if (!oidcConfig) {
    const resp = await fetch(OIDC_CONFIG_URL);
    oidcConfig = await resp.json();
  }
  return oidcConfig;
}

async function getOIDCAccessToken(code: string) {
  const form = new URLSearchParams();
  form.append("client_id", OIDC_CLIENT_ID);
  form.append("client_secret", OIDC_CLIENT_SECRET);
  form.append("grant_type", "authorization_code");
  form.append("code", code);
  form.append("redirect_uri", FILESTASH_REDIRECT_URI);
  const config = await getOIDCConfig();
  const resp = await fetch(config.token_endpoint, {
    method: "POST",
    body: form,
  });
  const json = await resp.json();

  return json.access_token as string;
}

async function getUserinfo(accessToken: string) {
  const config = await getOIDCConfig();
  const resp = await fetch(config.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return await resp.json();
}

async function createToken() {
  const resp = await fetch(`${SFTPGO_WEB_URL}/api/v2/token`, {
    headers: { Authorization: `Basic ${SFTPGO_ADMIN_BASICAUTH}` },
  });
  const json = await resp.json();
  return json.access_token as string;
}

async function findUser(apiToken: string, username: string) {
  const resp = await fetch(
    `${SFTPGO_WEB_URL}/api/v2/users/${encodeURIComponent(username)}`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
    }
  );
  if (resp.ok) {
    return await resp.json();
  } else {
    return undefined;
  }
}

interface SFTPGoGroup {
  name: string;
  type: number;
}

async function createUser(
  apiToken: string,
  username: string,
  groups: SFTPGoGroup[]
) {
  const user = {
    status: 1,
    username,
    groups,
    permissions: {
      "/": ["list"],
    },
    public_keys: [PUBKEY],
  };

  const resp = await fetch(`${SFTPGO_WEB_URL}/api/v2/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify(user),
  });

  if (!resp.ok) {
    console.error(await resp.text());
  }
}

// deno-lint-ignore no-explicit-any
async function updateUser(apiToken: string, user: any, groups: SFTPGoGroup[]) {
  const public_keys = user.public_keys ?? [];
  if (!public_keys.includes(PUBKEY)) {
    public_keys.push(PUBKEY);
  }

  const payload = {
    ...user,
    status: 1,
    groups,
    public_keys,
  };

  const resp = await fetch(
    `${SFTPGO_WEB_URL}/api/v2/users/${encodeURIComponent(user.username)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(payload),
    }
  );

  if (!resp.ok) {
    console.error(await resp.text());
  }
}

async function createFilestashSession(username: string) {
  const sessionUrl = new URL("/api/session", FILESTASH_URL);
  sessionUrl.searchParams.set("key", FILESTASH_API_KEY);
  const payload = {
    type: "sftp",
    hostname: SFTPGO_SFTP_HOST,
    port: SFTPGO_SFTP_PORT,
    username,
    password: PRIVKEY,
  };
  const resp = await fetch(sessionUrl, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const setCookie = resp.headers.get("Set-Cookie")!;
  return setCookie;
}

Deno.serve(app.fetch);
