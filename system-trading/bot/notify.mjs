/**
 * 디스코드 웹훅 알림 — 봇의 사이클 사건을 폰으로 보낸다.
 *
 * DISCORD_WEBHOOK_URL 이 없으면 조용한 no-op — 알림 끔과 같은 상태다.
 * 전송 실패는 경고만 남기고 삼킨다: 알림이 사이클(매매)을 깨는 일은 없어야 하고,
 * 다음 사이클이 4시간 뒤라 재시도해도 의미가 없다. 유실은 콘솔·jsonl 이 백업한다.
 */
export async function notify(text) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url || !text) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 디스코드 본문 한도는 2000자 — 넘치면 뒤를 자른다(핵심은 앞에 온다).
      body: JSON.stringify({ content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`알림 전송 실패: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`알림 전송 실패: ${e.message}`);
  }
}
