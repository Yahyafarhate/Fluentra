export type Locale = "fr" | "en" | "ar";
export const LOCALES: Locale[] = ["fr", "en", "ar"];

/** Keys whose delivery requires explicit marketing consent (not purely transactional). */
export const CONSENT_REQUIRED_KEYS = new Set(["followup_thanks", "feedback_request", "birthday_greeting", "anniversary_greeting", "campaign"]);

export const TEMPLATE_KEYS = [
  "booking_confirmation", "booking_pending", "booking_reminder", "booking_modified", "booking_cancelled",
  "waitlist_joined", "waitlist_ready", "followup_thanks", "feedback_request", "birthday_greeting", "anniversary_greeting",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_VARS = ["guest_name", "restaurant", "date", "time", "party_size", "code", "manage_link", "address", "policy", "feedback_link", "unsubscribe_link", "wait_minutes"];

interface T { subject: string; body: string }
type Catalog = Record<TemplateKey | "password_reset" | "invitation", Record<Locale, T>>;

export const DEFAULT_TEMPLATES: Catalog = {
  booking_confirmation: {
    fr: { subject: "Réservation confirmée — {{restaurant}}", body: "Bonjour {{guest_name}},\n\nVotre réservation chez {{restaurant}} est confirmée : {{party_size}} personne(s) le {{date}} à {{time}}.\nCode : {{code}}\nAdresse : {{address}}\n\nModifier ou annuler : {{manage_link}}\n{{policy}}" },
    en: { subject: "Booking confirmed — {{restaurant}}", body: "Hello {{guest_name}},\n\nYour reservation at {{restaurant}} is confirmed: {{party_size}} guest(s) on {{date}} at {{time}}.\nCode: {{code}}\nAddress: {{address}}\n\nChange or cancel: {{manage_link}}\n{{policy}}" },
    ar: { subject: "تم تأكيد الحجز — {{restaurant}}", body: "مرحباً {{guest_name}}،\n\nتم تأكيد حجزكم في {{restaurant}}: {{party_size}} شخص بتاريخ {{date}} الساعة {{time}}.\nالرمز: {{code}}\nالعنوان: {{address}}\n\nللتعديل أو الإلغاء: {{manage_link}}\n{{policy}}" },
  },
  booking_pending: {
    fr: { subject: "Demande de réservation reçue — {{restaurant}}", body: "Bonjour {{guest_name}},\n\nNous avons bien reçu votre demande ({{party_size}} pers., {{date}} à {{time}}). Elle sera confirmée prochainement par {{restaurant}}.\nCode : {{code}}\nSuivi / annulation : {{manage_link}}" },
    en: { subject: "Booking request received — {{restaurant}}", body: "Hello {{guest_name}},\n\nWe received your request ({{party_size}} guests, {{date}} at {{time}}). {{restaurant}} will confirm it shortly.\nCode: {{code}}\nTrack / cancel: {{manage_link}}" },
    ar: { subject: "تم استلام طلب الحجز — {{restaurant}}", body: "مرحباً {{guest_name}}،\n\nاستلمنا طلبكم ({{party_size}} أشخاص، {{date}} الساعة {{time}}). سيؤكده {{restaurant}} قريباً.\nالرمز: {{code}}\nالمتابعة / الإلغاء: {{manage_link}}" },
  },
  booking_reminder: {
    fr: { subject: "Rappel : votre table chez {{restaurant}}", body: "Bonjour {{guest_name}}, rappel de votre réservation chez {{restaurant}} le {{date}} à {{time}} ({{party_size}} pers.).\nModifier ou annuler : {{manage_link}}" },
    en: { subject: "Reminder: your table at {{restaurant}}", body: "Hello {{guest_name}}, a reminder of your reservation at {{restaurant}} on {{date}} at {{time}} ({{party_size}} guests).\nChange or cancel: {{manage_link}}" },
    ar: { subject: "تذكير: طاولتكم في {{restaurant}}", body: "مرحباً {{guest_name}}، تذكير بحجزكم في {{restaurant}} بتاريخ {{date}} الساعة {{time}} ({{party_size}} أشخاص).\nللتعديل أو الإلغاء: {{manage_link}}" },
  },
  booking_modified: {
    fr: { subject: "Réservation modifiée — {{restaurant}}", body: "Bonjour {{guest_name}}, votre réservation chez {{restaurant}} a été modifiée : {{party_size}} pers. le {{date}} à {{time}}.\nCode : {{code}} — {{manage_link}}" },
    en: { subject: "Booking updated — {{restaurant}}", body: "Hello {{guest_name}}, your reservation at {{restaurant}} was updated: {{party_size}} guests on {{date}} at {{time}}.\nCode: {{code}} — {{manage_link}}" },
    ar: { subject: "تم تعديل الحجز — {{restaurant}}", body: "مرحباً {{guest_name}}، تم تعديل حجزكم في {{restaurant}}: {{party_size}} أشخاص بتاريخ {{date}} الساعة {{time}}.\nالرمز: {{code}} — {{manage_link}}" },
  },
  booking_cancelled: {
    fr: { subject: "Réservation annulée — {{restaurant}}", body: "Bonjour {{guest_name}}, votre réservation (code {{code}}) du {{date}} à {{time}} chez {{restaurant}} a été annulée. Nous espérons vous accueillir bientôt." },
    en: { subject: "Booking cancelled — {{restaurant}}", body: "Hello {{guest_name}}, your reservation (code {{code}}) on {{date}} at {{time}} at {{restaurant}} has been cancelled. We hope to welcome you soon." },
    ar: { subject: "تم إلغاء الحجز — {{restaurant}}", body: "مرحباً {{guest_name}}، تم إلغاء حجزكم (الرمز {{code}}) بتاريخ {{date}} الساعة {{time}} في {{restaurant}}. نأمل استقبالكم قريباً." },
  },
  waitlist_joined: {
    fr: { subject: "Liste d'attente — {{restaurant}}", body: "Bonjour {{guest_name}}, vous êtes sur la liste d'attente de {{restaurant}} ({{party_size}} pers.). Attente estimée : environ {{wait_minutes}} min (estimation, non garantie)." },
    en: { subject: "Waitlist — {{restaurant}}", body: "Hello {{guest_name}}, you are on the waitlist at {{restaurant}} ({{party_size}} guests). Estimated wait: about {{wait_minutes}} min (an estimate, not a guarantee)." },
    ar: { subject: "قائمة الانتظار — {{restaurant}}", body: "مرحباً {{guest_name}}، أنتم في قائمة الانتظار في {{restaurant}} ({{party_size}} أشخاص). مدة الانتظار التقديرية حوالي {{wait_minutes}} دقيقة (تقدير وليست مضمونة)." },
  },
  waitlist_ready: {
    fr: { subject: "Votre table est prête — {{restaurant}}", body: "Bonjour {{guest_name}}, votre table est prête chez {{restaurant}}. Merci de vous présenter à l'accueil." },
    en: { subject: "Your table is ready — {{restaurant}}", body: "Hello {{guest_name}}, your table is ready at {{restaurant}}. Please check in with the host." },
    ar: { subject: "طاولتكم جاهزة — {{restaurant}}", body: "مرحباً {{guest_name}}، طاولتكم جاهزة في {{restaurant}}. يرجى التوجه إلى الاستقبال." },
  },
  followup_thanks: {
    fr: { subject: "Merci de votre visite — {{restaurant}}", body: "Bonjour {{guest_name}}, merci d'avoir dîné chez {{restaurant}}. Nous espérons vous revoir bientôt !\n{{unsubscribe_link}}" },
    en: { subject: "Thank you for visiting — {{restaurant}}", body: "Hello {{guest_name}}, thank you for dining at {{restaurant}}. We hope to see you again soon!\n{{unsubscribe_link}}" },
    ar: { subject: "شكراً لزيارتكم — {{restaurant}}", body: "مرحباً {{guest_name}}، شكراً لتناولكم الطعام في {{restaurant}}. نأمل رؤيتكم قريباً!\n{{unsubscribe_link}}" },
  },
  feedback_request: {
    fr: { subject: "Votre avis compte — {{restaurant}}", body: "Bonjour {{guest_name}}, comment s'est passée votre visite chez {{restaurant}} ? Donnez-nous votre avis : {{feedback_link}}\n{{unsubscribe_link}}" },
    en: { subject: "How was your visit — {{restaurant}}", body: "Hello {{guest_name}}, how was your visit to {{restaurant}}? Share your feedback: {{feedback_link}}\n{{unsubscribe_link}}" },
    ar: { subject: "رأيكم يهمنا — {{restaurant}}", body: "مرحباً {{guest_name}}، كيف كانت زيارتكم إلى {{restaurant}}؟ شاركونا رأيكم: {{feedback_link}}\n{{unsubscribe_link}}" },
  },
  birthday_greeting: {
    fr: { subject: "Joyeux anniversaire ! — {{restaurant}}", body: "Joyeux anniversaire {{guest_name}} ! Toute l'équipe de {{restaurant}} serait ravie de fêter ça avec vous.\n{{unsubscribe_link}}" },
    en: { subject: "Happy birthday! — {{restaurant}}", body: "Happy birthday {{guest_name}}! The {{restaurant}} team would love to celebrate with you.\n{{unsubscribe_link}}" },
    ar: { subject: "عيد ميلاد سعيد! — {{restaurant}}", body: "عيد ميلاد سعيد {{guest_name}}! يسعد فريق {{restaurant}} بالاحتفال معكم.\n{{unsubscribe_link}}" },
  },
  anniversary_greeting: {
    fr: { subject: "Joyeux anniversaire de mariage — {{restaurant}}", body: "Bonjour {{guest_name}}, {{restaurant}} vous souhaite une merveilleuse célébration.\n{{unsubscribe_link}}" },
    en: { subject: "Happy anniversary — {{restaurant}}", body: "Hello {{guest_name}}, {{restaurant}} wishes you a wonderful celebration.\n{{unsubscribe_link}}" },
    ar: { subject: "ذكرى سعيدة — {{restaurant}}", body: "مرحباً {{guest_name}}، يتمنى لكم {{restaurant}} احتفالاً رائعاً.\n{{unsubscribe_link}}" },
  },
  password_reset: {
    fr: { subject: "Réinitialisation de votre mot de passe Fluentra", body: "Bonjour {{name}},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n{{link}}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message." },
    en: { subject: "Reset your Fluentra password", body: "Hello {{name}},\n\nTo choose a new password open this link (valid for 1 hour):\n{{link}}\n\nIf you did not request this, ignore this message." },
    ar: { subject: "إعادة تعيين كلمة مرور Fluentra", body: "مرحباً {{name}}،\n\nلاختيار كلمة مرور جديدة افتح الرابط (صالح لمدة ساعة):\n{{link}}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة." },
  },
  invitation: {
    fr: { subject: "Invitation à rejoindre {{org}} sur Fluentra", body: "Bonjour,\n\n{{inviter}} vous invite à rejoindre {{org}} ({{role}}). Acceptez l'invitation (valable 7 jours) :\n{{link}}" },
    en: { subject: "You're invited to join {{org}} on Fluentra", body: "Hello,\n\n{{inviter}} invited you to join {{org}} ({{role}}). Accept the invitation (valid 7 days):\n{{link}}" },
    ar: { subject: "دعوة للانضمام إلى {{org}} على Fluentra", body: "مرحباً،\n\nدعاكم {{inviter}} للانضمام إلى {{org}} ({{role}}). اقبلوا الدعوة (صالحة 7 أيام):\n{{link}}" },
  },
};

export function render(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => (vars[k] == null ? "" : String(vars[k]))).replace(/\n{3,}/g, "\n\n").trim();
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const toHtml = (text: string) =>
  `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#222">${escapeHtml(text).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>`;
