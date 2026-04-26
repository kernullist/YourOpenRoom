import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import zh from './zh';

void i18n.use(initReactI18next).init({
  resources: {
    en: {
      openvscode: en,
    },
    zh: {
      openvscode: zh,
    },
  },
  lng: i18n.language || 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  ns: ['openvscode'],
  defaultNS: 'openvscode',
});
