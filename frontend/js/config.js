const CONFIG = {
  API_URL: "https://crm-leads-production-27fc.up.railway.app",
  WS_URL: "wss://crm-leads-production-27fc.up.railway.app/ws",
  VERSION: "1.2.0",
  // Preencha depois que criar o App no Meta for Developers e a Login Configuration
  // do Embedded Signup. Nenhum desses dois é secreto — só o App Secret é (esse fica
  // só no backend, nunca aqui).
  META_APP_ID: "",           // ex: "1234567890123456"
  META_CONFIG_ID: "",        // ID da Login Configuration (WhatsApp Embedded Signup)
};
window.__META_APP_ID__ = CONFIG.META_APP_ID;
