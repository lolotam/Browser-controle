# Browser Agent — إكستنشن كروم بيتحكم في البراوزر بالذكاء الاصطناعي

وكيل بيشتغل من اللوحة الجانبية (Side Panel) في كروم. بتديله مهمة بالعربي أو الإنجليزي، فينفذها خطوة بخطوة في البراوزر بتاعك (بحث، ضغط، كتابة، اختيار من قوائم، سكرول، تنقل بين التابات، قراءة وتجميع معلومات)، وفي الآخر بيديك **تقرير نهائي** فيه النتايج والمصادر.

## المزوّدين المدعومين

| المزوّد | طريقة الدخول | ملاحظات |
|---|---|---|
| **اشتراك ChatGPT** (Plus / Pro / Business) | تسجيل دخول بحساب ChatGPT (نفس طريقة Codex CLI) | الموديلات ومستويات التفكير بتتحمّل تلقائيًا من حسابك |
| **xAI Grok** | API key من console.x.ai | اشتراك SuperGrok **مش** بيدّي API — لازم API key منفصل |
| **Z.ai GLM** | API key (أو مفتاح GLM Coding Plan) | فيه preset لـ Coding Plan و preset للـ API العادي |
| OpenAI API / OpenRouter / أي سيرفر متوافق | API key + Base URL | |

## التثبيت

1. افتح `chrome://extensions` وفعّل **Developer mode**.
2. اضغط **Load unpacked** واختار فولدر `browser-agent-extension`.
3. اضغط أيقونة الإكستنشن (أو `Alt+Shift+A`) — اللوحة الجانبية هتفتح على الإعدادات.

## ربط اشتراك ChatGPT

1. من الإعدادات اختار **اشتراك ChatGPT** واضغط **تسجيل الدخول بحساب ChatGPT**.
2. هتتفتح صفحة `auth.openai.com/codex/device` — سجّل دخول واكتب الكود اللي ظاهر في اللوحة.
3. بعد الموافقة، قائمة الموديلات بتتحمّل لوحدها، واختار **الموديل** و**مستوى التفكير (Reasoning effort)** — المستويات المتاحة بتتغير حسب الموديل.

لو ظهر إن device code مش مفعّل: فعّل "device code authorization for Codex" من إعدادات الأمان في ChatGPT، **أو** استخدم البديل: شغّل `codex login` على جهازك والصق محتوى `~/.codex/auth.json` في خانة الاستيراد.

## الأدوات اللي الوكيل بيستخدمها

`read_page` · `navigate` · `web_search` · `click` · `click_at` · `type_text` · `press_key` · `select_option` · `hover` · `scroll` · `get_text` · `screenshot` · `history` · `wait` · `list_tabs` · `switch_tab` · `open_tab` · `close_tab` · `run_javascript` (اختياري) · `ask_user` · `done`

- الضغط والكتابة بيتعملوا عن طريق Chrome DevTools Protocol (`chrome.debugger`)، فبيبقوا أحداث حقيقية زي المستخدم بالظبط وبيشتغلوا على المواقع اللي بتتجاهل الأحداث المصطنعة.
- قبل الشراء/الدفع/إرسال رسائل/حذف بيانات/كتابة باسوردات، الوكيل **لازم** يسألك ويستنى موافقتك (`ask_user`).
- محتوى الصفحات بيتعامل معاه كبيانات مش أوامر (حماية من prompt injection) — ودي حماية على مستوى الـ prompt مش ضمان كامل.

## حاجات لازم تعرفها (بصراحة)

- **استخدام اشتراك ChatGPT برّه تطبيقات OpenAI منطقة رمادية.** الإكستنشن بيستخدم نفس OAuth client ونفس الـ backend (`chatgpt.com/backend-api/codex`) بتوع Codex CLI. OpenAI ممكن تغيّر الـ API أو تمنعه في أي وقت، والاستخدام بيتحسب من حدود خطتك (Codex limits).
- **مسار ChatGPT متختبرش على حساب حقيقي** في بيئة التطوير — اتختبر بـ mock مطابق لكود Codex الرسمي. أول تجربة على حسابك هي الاختبار الحقيقي؛ لو حصل خطأ، الرسالة بتظهر في الشات كما هي.
- لما الوكيل يشتغل، كروم بيظهر شريط "Browser Agent started debugging this browser" — ده طبيعي ومطلوب لـ `chrome.debugger`.
- كروم مش بيسمح لأي إكستنشن يتحكم في صفحات `chrome://` و Chrome Web Store.
- التوكنز ومفاتيح الـ API متخزنة في `chrome.storage.local` على جهازك (مش متشفرة) ومش بتتبعت لأي حد غير المزوّد اللي اخترته.
- `run_javascript` مقفول افتراضيًا لأنه بيدي الموديل صلاحية كاملة على الصفحة.

## البنية

```
manifest.json
src/
  background/service-worker.js   تنسيق التشغيل + الرسائل مع اللوحة + تسجيل الدخول
  agent/agent.js                 حلقة observe → decide → act
  agent/tools.js                 تعريف الأدوات وتنفيذها
  agent/prompt.js                تعليمات النظام وقواعد الأمان
  browser/controller.js          التحكم عبر CDP (ضغط، كتابة، سكرول، سكرين شوت)
  browser/page-scripts.js        سكربتات بتتحقن في الصفحة (ترقيم العناصر، قراءة النص)
  providers/chatgpt-auth.js      تسجيل دخول ChatGPT بالـ device code + refresh
  providers/chatgpt.js           Responses API على backend Codex
  providers/openai-compatible.js Chat Completions (Grok / GLM / OpenAI / OpenRouter)
  sidepanel/                     الواجهة (عربي RTL) + عارض Markdown آمن
test/                            اختبارات unit (node:test) + اختبار E2E
```

## الاختبارات

```bash
cd browser-agent-extension
npm test          # اختبارات unit — مش محتاجة تثبيت
npm install
npm run e2e       # بيحمّل الإكستنشن في Chromium مع موديل وهمي ويتأكد إنه بيكتب ويختار ويضغط ويطلّع تقرير
# لو Chromium بتاع Playwright مش متثبت: CHROMIUM_PATH=/path/to/chrome npm run e2e
```
