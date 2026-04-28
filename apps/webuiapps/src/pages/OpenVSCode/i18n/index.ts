import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import ko from './ko';
import zh from './zh';

const NAMESPACE = 'openvscode';
const resources = {
  en: { [NAMESPACE]: en },
  'en-US': { [NAMESPACE]: en },
  'en-GB': { [NAMESPACE]: en },
  zh: { [NAMESPACE]: zh },
  'zh-CN': { [NAMESPACE]: zh },
  ko: { [NAMESPACE]: ko },
  'ko-KR': { [NAMESPACE]: ko },
  pt: { [NAMESPACE]: en },
  'pt-BR': { [NAMESPACE]: en },
  es: { [NAMESPACE]: en },
  'es-ES': { [NAMESPACE]: en },
  ja: { [NAMESPACE]: en },
  'ja-JP': { [NAMESPACE]: en },
};

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: i18n.language || 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    ns: [NAMESPACE],
    defaultNS: NAMESPACE,
  });
} else {
  Object.entries(resources).forEach(([language, bundle]) => {
    i18n.addResourceBundle(language, NAMESPACE, bundle[NAMESPACE], true, true);
  });
}
