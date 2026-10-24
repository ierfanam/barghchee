import os
from typing import Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()
app = FastAPI(title="NAVA Live Avatar API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(","), allow_credentials=False, allow_methods=["GET", "POST"], allow_headers=["*"])

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    model: str = Field(default="openai/gpt-4o-mini", max_length=120)

@app.get("/api/health")
async def health():
    return {"ok": True, "provider": "openrouter", "configured": bool(os.getenv("OPENROUTER_API_KEY"))}

@app.post("/api/chat")
async def chat(req: ChatRequest):
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="کلید OPENROUTER_API_KEY در فایل .env سرور تنظیم نشده است.")
    client = AsyncOpenAI(base_url="https://openrouter.ai/api/v1", api_key=key, default_headers={"HTTP-Referer": os.getenv("APP_URL", "http://localhost:3000"), "X-Title": "NAVA AI Live Avatar"})
    history = [{"role": m.get("role"), "content": str(m.get("content", ""))[:12000]} for m in req.history[-12:] if m.get("role") in ("user", "assistant")]
    if not history or history[-1].get("role") != "user" or history[-1].get("content") != req.message:
        history.append({"role": "user", "content": req.message})
    try:
        response = await client.chat.completions.create(model=req.model, messages=[{"role": "system", "content": "تو NAVA هستی؛ دستیار فارسی‌زبان، طبیعی، مؤدب و دقیق. پاسخ را محاوره‌ای، روشن و مختصر بده. اگر چیزی را نمی‌دانی صادقانه بگو."}, *history], temperature=0.7, max_tokens=700)
        return {"reply": response.choices[0].message.content or "پاسخی تولید نشد.", "model": response.model}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"خطا در ارتباط با OpenRouter: {str(exc)[:300]}") from exc
