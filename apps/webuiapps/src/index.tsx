import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { loadPersistedConfig } from '@/lib/configPersistence';
import rootRouter from '@/routers';

import './common.scss';
import { initI18n } from './i18';

declare const __ROUTER_BASE__: string;

initI18n();

void loadPersistedConfig().then((config) => {
  const title = config?.app?.title?.trim();
  if (title) {
    document.title = title;
  }
});

const basename = typeof __ROUTER_BASE__ !== 'undefined' && __ROUTER_BASE__ ? __ROUTER_BASE__ : '/';

const router = createBrowserRouter(rootRouter, { basename });

ReactDOM.createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
