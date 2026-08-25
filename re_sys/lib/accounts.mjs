/**
 * OKX 계정 연결 정보 — 복기 수집이 바라보는 계정은 두 갈래다.
 *
 *   live — .env.local 의 OKX_API_KEY (봇·DOGE 계정, uid 6419***)
 *   app  — 앱 설정에서 등록해 Supabase Vault 에 저장된 키 (주 매매 계정, uid 4966***)
 *
 * 2026-08-18 점검에서 이 둘이 서로 다른 계정임이 확인됐다 — "이전에 조회되던 내역"은
 * 앱 동기화(Vault)가 보던 매매 계정이고, 봇 키로는 보이지 않는다. 복기는 둘 다 본다.
 * 키 원문은 어디에도 저장·출력하지 않는다.
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "./data.mjs";

export function loadEnv() {
  const raw = readFileSync(join(ROOT, "..", ".env.local"), "utf8");
  return Object.fromEntries(
    raw.split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

export async function okxCall(creds, method, path, body) {
  const ts = new Date().toISOString();
  const payload = body ? JSON.stringify(body) : "";
  const sign = createHmac("sha256", creds.secret).update(ts + method + path + payload).digest("base64");
  const res = await fetch("https://www.okx.com" + path, {
    method,
    headers: {
      "OK-ACCESS-KEY": creds.key,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": creds.passphrase,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: payload || undefined,
  });
  return res.json();
}

/** okxCall 에 실패-throw 를 얹은 GET — 수집 루프가 코드 검사를 반복하지 않게. */
export async function okxGet(creds, path) {
  const json = await okxCall(creds, "GET", path);
  if (json.code !== "0") throw new Error(`OKX ${path}: ${json.msg || json.code}`);
  return json.data;
}

/**
 * 수집 대상 계정 전부 — env 키 + Vault(exchange_accounts) 키.
 * 같은 api_key 가 겹치면 한 번만 쓴다. 각 계정에 uid 를 붙여 이름을 구분한다.
 */
export async function allAccounts(env) {
  const out = [];
  if (env.OKX_API_KEY && env.OKX_API_SECRET && env.OKX_API_PASSPHRASE) {
    out.push({
      tag: "live",
      idPrefix: "okx",
      creds: { key: env.OKX_API_KEY, secret: env.OKX_API_SECRET, passphrase: env.OKX_API_PASSPHRASE },
      name: "OKX 봇계정",
    });
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const skey = env.SUPABASE_SECRET_KEY;
  if (url && skey) {
    const H = { apikey: skey, authorization: `Bearer ${skey}` };
    const res = await fetch(`${url}/rest/v1/exchange_accounts?select=id,label,exchange`, { headers: H });
    const rows = await res.json();
    for (const a of (Array.isArray(rows) ? rows : []).filter((r) => r.exchange === "okx")) {
      const rr = await fetch(`${url}/rest/v1/rpc/okx_credentials`, {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ p_account_id: a.id }),
      });
      const cred = (await rr.json())?.[0];
      if (!cred?.api_key) continue;
      if (out.some((x) => x.creds.key === cred.api_key)) continue; // env 와 같은 키면 중복
      out.push({
        tag: "app",
        idPrefix: "okxv",
        creds: { key: cred.api_key, secret: cred.api_secret, passphrase: cred.passphrase },
        name: `OKX 매매계정(${a.label})`,
      });
    }
  }

  // uid 를 이름에 붙인다 — "어느 계정 거래인가"가 리포트에서 식별돼야 한다.
  for (const acct of out) {
    try {
      const [cfg] = await okxGet(acct.creds, "/api/v5/account/config");
      acct.uid = String(cfg.uid);
      acct.name += ` uid ${acct.uid.slice(0, 4)}***`;
    } catch {
      acct.uid = null;
    }
  }
  return out;
}
