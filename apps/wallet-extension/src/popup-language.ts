/** Popup text only. No authority, account descriptor, or signer payload is translated. */
export const popupLanguages = [
  {
    value: "en",
    label: "English",
  },
  {
    value: "zh-Hans",
    label: "简体中文",
  },
  {
    value: "zh-Hant",
    label: "繁體中文",
  },
  {
    value: "fr",
    label: "Français",
  },
  {
    value: "es",
    label: "Español",
  },
  {
    value: "de",
    label: "Deutsch",
  },
  {
    value: "ko",
    label: "한국어",
  },
  {
    value: "ja",
    label: "日本語",
  },
] as const;
export type PopupLocale = (typeof popupLanguages)[number]["value"];
export const popupLanguageStorageKey = "artfi.popup.locale.v1";
const english = {
  language: "Language",
  boundary:
    "Hoodi only. Signing remains in an approved hardware wallet or WalletConnect session.",
  checking: "Checking encrypted vault…",
  unconfigured: "No encrypted connector vault configured.",
  locked: "Coordinator locked. Unlock it before a site can read an account.",
  unlocked: "Coordinator unlocked for this browser session.",
  refreshFailure:
    "Coordinator status is unavailable. Reopen the popup to try again.",
  password: "Vault password",
  newPassword: "New vault password (12 characters or more)",
  account: "Account address",
  signer: "Signer",
  hardware: "Hardware wallet",
  unlock: "Unlock coordinator",
  create: "Create coordinator vault",
  thisSite: "This site",
  readingTab: "Reading the active tab…",
  enable: "Enable for this site",
  disable: "Disable for this site",
  enabledSites: "Enabled sites",
  noSites: "No site is enabled.",
  coordinator: "Coordinator",
  lock: "Lock coordinator",
  unsupportedSite: "This tab cannot use the wallet (HTTPS only).",
  siteEnabled: "{origin} is enabled.",
  siteDisabled: "{origin} is not enabled.",
  siteFailure:
    "Site access could not be updated. Reopen the popup to check its current status.",
  passwordMinimum: "The vault password must contain at least 12 characters.",
  addressRequired: "An account address is required to create the vault.",
  vaultFailure:
    "The vault could not be opened. Check the password and try again.",
  preferenceSaved: "Language preference saved on this browser.",
  preferenceUnsaved:
    "Language changed for this view. The preference could not be saved.",
} as const;
export type PopupMessageKey = keyof typeof english;
export const popupMessageKeys = Object.keys(english) as PopupMessageKey[];
const messages: Record<PopupLocale, Record<PopupMessageKey, string>> = {
  en: english,
  "zh-Hans": {
    language: "语言",
    boundary: "仅限 Hoodi。签名仍由获准的硬件钱包或 WalletConnect 会话完成。",
    checking: "正在检查加密保险库…",
    unconfigured: "尚未配置加密连接器保险库。",
    locked: "协调器已锁定。网站读取账户前请先解锁。",
    unlocked: "协调器已在本次浏览器会话中解锁。",
    refreshFailure: "无法读取协调器状态。请重新打开弹窗重试。",
    password: "保险库密码",
    newPassword: "新保险库密码（至少 12 个字符）",
    account: "账户地址",
    signer: "签名器",
    hardware: "硬件钱包",
    unlock: "解锁协调器",
    create: "创建协调器保险库",
    thisSite: "当前网站",
    readingTab: "正在读取当前标签页…",
    enable: "为此网站启用",
    disable: "为此网站停用",
    enabledSites: "已启用的网站",
    noSites: "尚未启用任何网站。",
    coordinator: "协调器",
    lock: "锁定协调器",
    unsupportedSite: "此标签页无法使用钱包（仅支持 HTTPS）。",
    siteEnabled: "已为 {origin} 启用。",
    siteDisabled: "尚未为 {origin} 启用。",
    siteFailure: "无法更新网站访问权限。请重新打开弹窗核实当前状态。",
    passwordMinimum: "保险库密码必须至少包含 12 个字符。",
    addressRequired: "创建保险库需要填写账户地址。",
    vaultFailure: "无法打开保险库。请检查密码后重试。",
    preferenceSaved: "语言偏好已保存在此浏览器。",
    preferenceUnsaved: "本次界面的语言已更改，但无法保存偏好。",
  },
  "zh-Hant": {
    language: "語言",
    boundary:
      "僅限 Hoodi。簽章仍由獲准的硬體錢包或 WalletConnect 工作階段完成。",
    checking: "正在檢查加密保險庫…",
    unconfigured: "尚未設定加密連接器保險庫。",
    locked: "協調器已鎖定。網站讀取帳戶前請先解鎖。",
    unlocked: "協調器已在本次瀏覽器工作階段中解鎖。",
    refreshFailure: "無法讀取協調器狀態。請重新開啟彈出視窗重試。",
    password: "保險庫密碼",
    newPassword: "新保險庫密碼（至少 12 個字元）",
    account: "帳戶地址",
    signer: "簽章器",
    hardware: "硬體錢包",
    unlock: "解鎖協調器",
    create: "建立協調器保險庫",
    thisSite: "目前網站",
    readingTab: "正在讀取目前分頁…",
    enable: "為此網站啟用",
    disable: "為此網站停用",
    enabledSites: "已啟用的網站",
    noSites: "尚未啟用任何網站。",
    coordinator: "協調器",
    lock: "鎖定協調器",
    unsupportedSite: "此分頁無法使用錢包（僅支援 HTTPS）。",
    siteEnabled: "已為 {origin} 啟用。",
    siteDisabled: "尚未為 {origin} 啟用。",
    siteFailure: "無法更新網站存取權限。請重新開啟彈出視窗核實目前狀態。",
    passwordMinimum: "保險庫密碼必須至少包含 12 個字元。",
    addressRequired: "建立保險庫需要填寫帳戶地址。",
    vaultFailure: "無法開啟保險庫。請檢查密碼後重試。",
    preferenceSaved: "語言偏好已儲存在此瀏覽器。",
    preferenceUnsaved: "本次介面的語言已變更，但無法儲存偏好。",
  },
  fr: {
    language: "Langue",
    boundary:
      "Hoodi uniquement. La signature reste dans un portefeuille matériel approuvé ou une session WalletConnect.",
    checking: "Vérification du coffre chiffré…",
    unconfigured: "Aucun coffre chiffré de connecteurs n’est configuré.",
    locked:
      "Coordinateur verrouillé. Déverrouillez-le avant qu’un site puisse lire un compte.",
    unlocked: "Coordinateur déverrouillé pour cette session du navigateur.",
    refreshFailure:
      "L’état du coordinateur est indisponible. Rouvrez la fenêtre pour réessayer.",
    password: "Mot de passe du coffre",
    newPassword: "Nouveau mot de passe du coffre (12 caractères minimum)",
    account: "Adresse du compte",
    signer: "Signataire",
    hardware: "Portefeuille matériel",
    unlock: "Déverrouiller le coordinateur",
    create: "Créer le coffre du coordinateur",
    thisSite: "Ce site",
    readingTab: "Lecture de l’onglet actif…",
    enable: "Activer pour ce site",
    disable: "Désactiver pour ce site",
    enabledSites: "Sites activés",
    noSites: "Aucun site n’est activé.",
    coordinator: "Coordinateur",
    lock: "Verrouiller le coordinateur",
    unsupportedSite:
      "Cet onglet ne peut pas utiliser le portefeuille (HTTPS uniquement).",
    siteEnabled: "{origin} est activé.",
    siteDisabled: "{origin} n’est pas activé.",
    siteFailure:
      "L’accès au site n’a pas pu être modifié. Rouvrez la fenêtre pour vérifier son état.",
    passwordMinimum:
      "Le mot de passe du coffre doit contenir au moins 12 caractères.",
    addressRequired:
      "Une adresse de compte est nécessaire pour créer le coffre.",
    vaultFailure:
      "Le coffre n’a pas pu être ouvert. Vérifiez le mot de passe et réessayez.",
    preferenceSaved: "Préférence linguistique enregistrée dans ce navigateur.",
    preferenceUnsaved:
      "La langue de cette vue a changé, mais la préférence n’a pas pu être enregistrée.",
  },
  es: {
    language: "Idioma",
    boundary:
      "Solo Hoodi. La firma permanece en una cartera física aprobada o una sesión de WalletConnect.",
    checking: "Comprobando la bóveda cifrada…",
    unconfigured: "No hay ninguna bóveda cifrada de conectores configurada.",
    locked:
      "Coordinador bloqueado. Desbloquéelo antes de que un sitio pueda leer una cuenta.",
    unlocked: "Coordinador desbloqueado para esta sesión del navegador.",
    refreshFailure:
      "El estado del coordinador no está disponible. Vuelva a abrir la ventana para reintentarlo.",
    password: "Contraseña de la bóveda",
    newPassword: "Nueva contraseña de la bóveda (12 caracteres como mínimo)",
    account: "Dirección de la cuenta",
    signer: "Firmante",
    hardware: "Cartera física",
    unlock: "Desbloquear coordinador",
    create: "Crear bóveda del coordinador",
    thisSite: "Este sitio",
    readingTab: "Leyendo la pestaña activa…",
    enable: "Habilitar para este sitio",
    disable: "Deshabilitar para este sitio",
    enabledSites: "Sitios habilitados",
    noSites: "No hay ningún sitio habilitado.",
    coordinator: "Coordinador",
    lock: "Bloquear coordinador",
    unsupportedSite: "Esta pestaña no puede usar la cartera (solo HTTPS).",
    siteEnabled: "{origin} está habilitado.",
    siteDisabled: "{origin} no está habilitado.",
    siteFailure:
      "No se pudo actualizar el acceso al sitio. Vuelva a abrir la ventana para comprobar su estado.",
    passwordMinimum:
      "La contraseña de la bóveda debe tener al menos 12 caracteres.",
    addressRequired:
      "Se requiere una dirección de cuenta para crear la bóveda.",
    vaultFailure:
      "No se pudo abrir la bóveda. Compruebe la contraseña y vuelva a intentarlo.",
    preferenceSaved: "Preferencia de idioma guardada en este navegador.",
    preferenceUnsaved:
      "El idioma de esta vista ha cambiado, pero no se pudo guardar la preferencia.",
  },
  de: {
    language: "Sprache",
    boundary:
      "Nur Hoodi. Das Signieren verbleibt in einer zugelassenen Hardware-Wallet oder WalletConnect-Sitzung.",
    checking: "Verschlüsselter Tresor wird geprüft…",
    unconfigured: "Kein verschlüsselter Konnektor-Tresor eingerichtet.",
    locked:
      "Koordinator gesperrt. Entsperren Sie ihn, bevor eine Website ein Konto lesen kann.",
    unlocked: "Koordinator für diese Browsersitzung entsperrt.",
    refreshFailure:
      "Der Koordinatorstatus ist nicht verfügbar. Öffnen Sie das Popup erneut.",
    password: "Tresorpasswort",
    newPassword: "Neues Tresorpasswort (mindestens 12 Zeichen)",
    account: "Kontoadresse",
    signer: "Signaturgeber",
    hardware: "Hardware-Wallet",
    unlock: "Koordinator entsperren",
    create: "Koordinator-Tresor erstellen",
    thisSite: "Diese Website",
    readingTab: "Aktiver Tab wird gelesen…",
    enable: "Für diese Website aktivieren",
    disable: "Für diese Website deaktivieren",
    enabledSites: "Aktivierte Websites",
    noSites: "Keine Website ist aktiviert.",
    coordinator: "Koordinator",
    lock: "Koordinator sperren",
    unsupportedSite: "Dieser Tab kann die Wallet nicht verwenden (nur HTTPS).",
    siteEnabled: "{origin} ist aktiviert.",
    siteDisabled: "{origin} ist nicht aktiviert.",
    siteFailure:
      "Der Websitezugriff konnte nicht aktualisiert werden. Öffnen Sie das Popup erneut, um den Status zu prüfen.",
    passwordMinimum: "Das Tresorpasswort muss mindestens 12 Zeichen enthalten.",
    addressRequired:
      "Zum Erstellen des Tresors ist eine Kontoadresse erforderlich.",
    vaultFailure:
      "Der Tresor konnte nicht geöffnet werden. Prüfen Sie das Passwort und versuchen Sie es erneut.",
    preferenceSaved: "Spracheinstellung in diesem Browser gespeichert.",
    preferenceUnsaved:
      "Die Sprache dieser Ansicht wurde geändert. Die Einstellung konnte nicht gespeichert werden.",
  },
  ko: {
    language: "언어",
    boundary:
      "Hoodi 전용입니다. 서명은 승인된 하드웨어 지갑 또는 WalletConnect 세션에서 수행됩니다.",
    checking: "암호화된 보관함 확인 중…",
    unconfigured: "암호화된 연결자 보관함이 구성되지 않았습니다.",
    locked:
      "조정기가 잠겼습니다. 사이트에서 계정을 읽으려면 먼저 잠금을 해제하세요.",
    unlocked: "현재 브라우저 세션에서 조정기 잠금이 해제되었습니다.",
    refreshFailure:
      "조정기 상태를 확인할 수 없습니다. 팝업을 다시 열어 재시도하세요.",
    password: "보관함 비밀번호",
    newPassword: "새 보관함 비밀번호(12자 이상)",
    account: "계정 주소",
    signer: "서명자",
    hardware: "하드웨어 지갑",
    unlock: "조정기 잠금 해제",
    create: "조정기 보관함 만들기",
    thisSite: "현재 사이트",
    readingTab: "현재 탭 읽는 중…",
    enable: "이 사이트에 사용 설정",
    disable: "이 사이트에 사용 중지",
    enabledSites: "사용 설정된 사이트",
    noSites: "사용 설정된 사이트가 없습니다.",
    coordinator: "조정기",
    lock: "조정기 잠금",
    unsupportedSite: "이 탭은 지갑을 사용할 수 없습니다(HTTPS 전용).",
    siteEnabled: "{origin}에 사용 설정되었습니다.",
    siteDisabled: "{origin}에 사용 설정되지 않았습니다.",
    siteFailure:
      "사이트 접근을 변경하지 못했습니다. 팝업을 다시 열어 현재 상태를 확인하세요.",
    passwordMinimum: "보관함 비밀번호는 12자 이상이어야 합니다.",
    addressRequired: "보관함을 만들려면 계정 주소가 필요합니다.",
    vaultFailure:
      "보관함을 열 수 없습니다. 비밀번호를 확인하고 다시 시도하세요.",
    preferenceSaved: "언어 설정을 이 브라우저에 저장했습니다.",
    preferenceUnsaved:
      "현재 화면의 언어가 변경되었으나 설정을 저장하지 못했습니다.",
  },
  ja: {
    language: "言語",
    boundary:
      "Hoodi 専用です。署名は承認済みのハードウェアウォレットまたは WalletConnect セッションで行います。",
    checking: "暗号化された保管庫を確認中…",
    unconfigured: "暗号化されたコネクター保管庫が未設定です。",
    locked:
      "コーディネーターはロックされています。サイトがアカウントを読み取る前に解除してください。",
    unlocked:
      "このブラウザーセッションではコーディネーターのロックが解除されています。",
    refreshFailure:
      "コーディネーターの状態を取得できません。ポップアップを開き直してください。",
    password: "保管庫のパスワード",
    newPassword: "新しい保管庫のパスワード（12文字以上）",
    account: "アカウントアドレス",
    signer: "署名者",
    hardware: "ハードウェアウォレット",
    unlock: "コーディネーターのロックを解除",
    create: "コーディネーター保管庫を作成",
    thisSite: "現在のサイト",
    readingTab: "現在のタブを読み取り中…",
    enable: "このサイトで有効にする",
    disable: "このサイトで無効にする",
    enabledSites: "有効なサイト",
    noSites: "有効なサイトはありません。",
    coordinator: "コーディネーター",
    lock: "コーディネーターをロック",
    unsupportedSite: "このタブではウォレットを使用できません（HTTPS のみ）。",
    siteEnabled: "{origin} は有効です。",
    siteDisabled: "{origin} は有効ではありません。",
    siteFailure:
      "サイトへのアクセスを更新できません。ポップアップを開き直して現在の状態を確認してください。",
    passwordMinimum: "保管庫のパスワードは12文字以上にしてください。",
    addressRequired: "保管庫の作成にはアカウントアドレスが必要です。",
    vaultFailure:
      "保管庫を開けません。パスワードを確認して再試行してください。",
    preferenceSaved: "言語設定をこのブラウザーに保存しました。",
    preferenceUnsaved:
      "この画面の言語は変更されましたが、設定を保存できませんでした。",
  },
};
export function isPopupLocale(value: unknown): value is PopupLocale {
  return (
    typeof value === "string" &&
    popupLanguages.some((entry) => entry.value === value)
  );
}
export function resolvePopupLocale(
  stored: unknown,
  preferred: readonly string[] = [],
): PopupLocale {
  if (isPopupLocale(stored)) return stored;
  for (const value of preferred) {
    const language = value.toLowerCase().replaceAll("_", "-");
    if (/^zh(?:-|$)/.test(language)) {
      if (/(?:^|-)hans(?:-|$)/.test(language)) return "zh-Hans";
      if (/(?:^|-)hant(?:-|$)/.test(language)) return "zh-Hant";
      return /(?:^|-)(tw|hk|mo)(?:-|$)/.test(language) ? "zh-Hant" : "zh-Hans";
    }
    const primary = language.split("-")[0];
    if (isPopupLocale(primary)) return primary;
  }
  return "en";
}
export function popupMessage(
  locale: PopupLocale,
  key: PopupMessageKey,
  origin = "",
): string {
  return messages[locale][key].replace("{origin}", () => origin);
}
export function vaultProblemKey(reason: string): PopupMessageKey {
  if (reason === "the vault password must contain at least 12 characters")
    return "passwordMinimum";
  if (reason === "an account address is required to create the vault")
    return "addressRequired";
  return "vaultFailure";
}
