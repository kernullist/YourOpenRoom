import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import ko from './ko';
import zh from './zh';

const NAMESPACE = 'album';
const resources = {
  en: { [NAMESPACE]: en },
  zh: { [NAMESPACE]: zh },
  'zh-CN': { [NAMESPACE]: zh },
  ko: { [NAMESPACE]: ko },
  'ko-KR': { [NAMESPACE]: ko },
  pt: { [NAMESPACE]: en },
  es: { [NAMESPACE]: en },
  ja: { [NAMESPACE]: en },
};

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: NAMESPACE,
    ns: [NAMESPACE],
    interpolation: {
      escapeValue: false,
    },
  });
} else {
  Object.entries(resources).forEach(([language, bundle]) => {
    i18n.addResourceBundle(language, NAMESPACE, bundle[NAMESPACE], true, true);
  });
}

export { NAMESPACE };
export default i18n;
