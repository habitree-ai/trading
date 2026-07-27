import { Output, generateText } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

/** 캡쳐가 커도 5MB면 충분하다 — 폰 스크린샷은 보통 1MB 미만. */
const MAX_BYTES = 5 * 1024 * 1024;

const ExtractionSchema = z.object({
  symbol: z.string().nullable().describe("기초자산 티커만. 예) BTCUSDT Perp → BTC"),
  side: z.enum(["long", "short"]).nullable().describe("포지션 방향"),
  orderRole: z
    .enum(["open", "close"])
    .nullable()
    .describe("이 주문이 진입인지 청산인지. OKX는 'Close long' / 'Open short'로 표기"),
  leverage: z.number().nullable().describe("레버리지 배수. '100x' → 100"),
  notional: z.number().nullable().describe("명목가. OKX의 'Order value'"),
  price: z.number().nullable().describe("체결가. OKX의 'Fill price'. ₮는 테더 기호이므로 원화가 아님"),
  pnl: z.number().nullable().describe("실현손익. 부호 포함. OKX의 'Closed PnL'"),
  pnl_pct: z.number().nullable().describe("손익률을 소수로. 41.75% → 0.4175"),
  fee: z.number().nullable().describe("수수료. 보통 음수"),
  filled_at: z
    .string()
    .nullable()
    .describe("체결 시각을 'YYYY-MM-DDTHH:mm:ss' 형식으로. 화면 시각은 KST 기준"),
  year_assumed: z
    .boolean()
    .describe("화면에 연도가 없어 추측했으면 true"),
});

export async function POST(request: Request) {
  // 이 라우트는 모델 호출 비용이 드므로 로그인한 사용자만 쓸 수 있다.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  if (!process.env.AI_GATEWAY_API_KEY) {
    return NextResponse.json(
      { error: "AI 비전이 설정되지 않았습니다. AI_GATEWAY_API_KEY를 등록해 주세요." },
      { status: 503 },
    );
  }

  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "이미지가 없습니다." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "이미지가 너무 큽니다(5MB 초과)." }, { status: 413 });
  }

  const ocrText = String(form.get("ocrText") ?? "");
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const result = await generateText({
      model: "anthropic/claude-sonnet-5",
      output: Output.object({ schema: ExtractionSchema }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "거래소 주문 상세 캡쳐다. 보이는 값만 읽어라. 추론하거나 지어내지 말고, 화면에 없으면 null로 둬라.",
                "주의: ₮ 기호는 테더(USDT)다. 원화가 아니다.",
                "주의: 'Closed PnL'과 'Closed PnL%'는 다른 값이다.",
                "주의: 'Order price'와 'Fill price'가 다르면 실제 체결가인 'Fill price'를 써라.",
                ocrText ? `참고용 OCR 텍스트(부정확할 수 있음):\n${ocrText}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            { type: "image", image: bytes, mediaType: file.type || "image/png" },
          ],
        },
      ],
    });

    return NextResponse.json({ fields: result.output, engine: "ai" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: `AI 추출 실패: ${message}` }, { status: 502 });
  }
}
