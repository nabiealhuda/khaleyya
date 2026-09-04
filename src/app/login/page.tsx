"use client";

import { useState, FormEvent } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "البريد الإلكتروني أو كلمة المرور غير صحيحة");
        setLoading(false);
        return;
      }
      // Full page navigation (not client-side routing) is required here:
      // /dashboard.html is a static file, and only a real new request will
      // carry the session cookie the login call just set past the proxy
      // that protects it.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/dashboard.html";
    } catch {
      setError("تعذّر الاتصال بالخادم. حاول مرة أخرى.");
      setLoading(false);
    }
  }

  return (
    <div style={page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=El+Messiri:wght@600;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        input:focus { outline: 2px solid #C9932E33; border-color: #C9932E !important; }
      `}</style>
      <div style={card}>
        <div style={brandRow}>
          <div style={brandMark}>خ</div>
          <div>
            <div style={brandName}>خَلِيّة</div>
            <div style={brandTag}>فريقك الكامل.. لقرارات أذكى</div>
          </div>
        </div>

        <h1 style={heading}>تسجيل الدخول</h1>
        <p style={subheading}>أدخل بيانات حسابك للوصول إلى لوحة متجرك</p>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={label}>البريد الإلكتروني</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={input}
              placeholder="example@store.com"
              dir="ltr"
            />
          </div>
          <div>
            <label style={label}>كلمة المرور</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={input}
              placeholder="••••••••"
              dir="ltr"
            />
          </div>

          {error && <div style={errorBox}>{error}</div>}

          <button type="submit" disabled={loading} style={submitBtn}>
            {loading ? "جارِ الدخول…" : "دخول"}
          </button>
        </form>
      </div>
    </div>
  );
}

const page: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#FBF7EF",
  fontFamily: "'IBM Plex Sans Arabic', ui-sans-serif, 'Segoe UI', Tahoma, sans-serif",
  padding: 20,
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 400,
  background: "#FFFFFF",
  border: "1px solid #E6DBC2",
  borderRadius: 18,
  padding: "32px 28px",
  boxShadow: "0 20px 50px -20px rgba(27,35,64,0.25)",
};

const brandRow: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center", marginBottom: 28 };
const brandMark: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 12,
  background: "linear-gradient(155deg,#C9932E,#A6741F)",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
  fontSize: 18,
  fontFamily: "'El Messiri', sans-serif",
};
const brandName: React.CSSProperties = { fontFamily: "'El Messiri', sans-serif", fontWeight: 700, fontSize: 19, color: "#1B2340", lineHeight: 1 };
const brandTag: React.CSSProperties = { fontSize: 11, color: "#4B5273", marginTop: 3 };

const heading: React.CSSProperties = { fontFamily: "'El Messiri', sans-serif", fontSize: 21, fontWeight: 700, color: "#1B2340", margin: "0 0 4px" };
const subheading: React.CSSProperties = { fontSize: 12.5, color: "#4B5273", margin: "0 0 22px" };

const label: React.CSSProperties = { display: "block", fontSize: 12, color: "#4B5273", marginBottom: 6 };
const input: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  borderRadius: 10,
  border: "1px solid #E6DBC2",
  background: "#FBF7EF",
  color: "#1B2340",
  fontFamily: "inherit",
  fontSize: 13.5,
};

const errorBox: React.CSSProperties = {
  background: "#FCEBEA",
  color: "#B3261E",
  fontSize: 12.5,
  padding: "9px 12px",
  borderRadius: 9,
  lineHeight: 1.7,
};

const submitBtn: React.CSSProperties = {
  marginTop: 6,
  padding: "12px 16px",
  borderRadius: 11,
  border: "none",
  background: "#C9932E",
  color: "#fff",
  fontFamily: "inherit",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
};
