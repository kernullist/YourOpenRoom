import React, { lazy } from 'react';
import { RouteObject } from 'react-router-dom';
import { cleanNil } from '@/utils/nil';

const Shell = lazy(() => import('@/components/Shell'));
const Home = lazy(() => import('@/pages/Home'));
const Twitter = lazy(() => import('@/pages/Twitter'));
const YouTube = lazy(() => import('@/pages/MusicApp'));
const Diary = lazy(() => import('@/pages/Diary'));
const Album = lazy(() => import('@/pages/Album'));
const FreeCell = lazy(() => import('@/pages/FreeCell'));
const Email = lazy(() => import('@/pages/Email'));
const Gomoku = lazy(() => import('@/pages/Gomoku'));
const Chess = lazy(() => import('@/pages/Chess'));
const EvidenceVault = lazy(() => import('@/pages/EvidenceVault'));
const CyberNews = lazy(() => import('@/pages/CyberNews'));
const Calendar = lazy(() => import('@/pages/Calendar'));
const Notes = lazy(() => import('@/pages/Notes'));
const BrowserReader = lazy(() => import('@/pages/BrowserReader'));
const Kira = lazy(() => import('@/pages/Kira'));
const OpenVSCode = lazy(() => import('@/pages/OpenVSCode'));
const PeAnalyzer = lazy(() => import('@/pages/PeAnalyzer'));
const RoomShop = lazy(() => import('@/pages/RoomShop'));
const DewdropCanvas = lazy(() => import('@/pages/DewdropCanvas'));
const WrittenByMe = lazy(() => import('@/pages/WrittenByMe'));
const AoiResearch = lazy(() => import('@/pages/AoiResearch'));
const AoiMemoryDashboard = lazy(() => import('@/pages/AoiMemoryDashboard'));
const MissionControl = lazy(() => import('@/pages/MissionControl'));

// All sub-pages should use lazy loading
const routerList: RouteObject[] = [
  {
    path: '/home',
    element: (
      <React.Suspense>
        <Home />
      </React.Suspense>
    ),
  },
  {
    path: '/twitter',
    element: (
      <React.Suspense>
        <Twitter />
      </React.Suspense>
    ),
  },
  {
    path: '/youtube',
    element: (
      <React.Suspense>
        <YouTube />
      </React.Suspense>
    ),
  },
  {
    path: '/diary',
    element: (
      <React.Suspense>
        <Diary />
      </React.Suspense>
    ),
  },
  {
    path: '/album',
    element: (
      <React.Suspense>
        <Album />
      </React.Suspense>
    ),
  },
  {
    path: '/freecell',
    element: (
      <React.Suspense>
        <FreeCell />
      </React.Suspense>
    ),
  },
  {
    path: '/email',
    element: (
      <React.Suspense>
        <Email />
      </React.Suspense>
    ),
  },
  {
    path: '/gomoku',
    element: (
      <React.Suspense>
        <Gomoku />
      </React.Suspense>
    ),
  },
  {
    path: '/chess',
    element: (
      <React.Suspense>
        <Chess />
      </React.Suspense>
    ),
  },
  {
    path: '/evidencevault',
    element: (
      <React.Suspense>
        <EvidenceVault />
      </React.Suspense>
    ),
  },
  {
    path: '/cyberNews',
    element: (
      <React.Suspense>
        <CyberNews />
      </React.Suspense>
    ),
  },
  {
    path: '/calendar',
    element: (
      <React.Suspense>
        <Calendar />
      </React.Suspense>
    ),
  },
  {
    path: '/notes',
    element: (
      <React.Suspense>
        <Notes />
      </React.Suspense>
    ),
  },
  {
    path: '/browser',
    element: (
      <React.Suspense>
        <BrowserReader />
      </React.Suspense>
    ),
  },
  {
    path: '/kira',
    element: (
      <React.Suspense>
        <Kira />
      </React.Suspense>
    ),
  },
  {
    path: '/ide',
    element: (
      <React.Suspense>
        <OpenVSCode />
      </React.Suspense>
    ),
  },
  {
    path: '/peanalyzer',
    element: (
      <React.Suspense>
        <PeAnalyzer />
      </React.Suspense>
    ),
  },
  {
    path: '/roomshop',
    element: (
      <React.Suspense>
        <RoomShop />
      </React.Suspense>
    ),
  },
  {
    path: '/dewdrop-canvas',
    element: (
      <React.Suspense>
        <DewdropCanvas />
      </React.Suspense>
    ),
  },
  {
    path: '/written-by-me',
    element: (
      <React.Suspense>
        <WrittenByMe />
      </React.Suspense>
    ),
  },
  {
    path: '/aoi-research',
    element: (
      <React.Suspense>
        <AoiResearch />
      </React.Suspense>
    ),
  },
  {
    path: '/aoi-memory',
    element: (
      <React.Suspense>
        <AoiMemoryDashboard />
      </React.Suspense>
    ),
  },
  {
    path: '/mission-control',
    element: (
      <React.Suspense>
        <MissionControl />
      </React.Suspense>
    ),
  },
];

interface RouterItemConfig {
  path?: RouteObject['path'];
  element?: RouteObject['element'];
  children?: RouteObject['children'];
  index?: RouteObject['index'];
  /** Methods and meta properties passed from router to page */
  handle?: RouteObject['handle'];
  meta?: Record<string, unknown>;
}

const generateRootRouter = (list: RouterItemConfig[]): RouteObject[] => {
  const traverse = (config: RouterItemConfig): RouteObject => {
    const children = config?.children?.length ? config.children.map(traverse) : undefined;
    return cleanNil({
      path: config?.path,
      element: config?.element,
      index: config?.index,
      handle: config?.meta
        ? {
            meta: config.meta,
          }
        : undefined,
      ...(children ? { children } : {}),
    }) as RouteObject;
  };
  return list.map(traverse);
};

// Local dev compatibility: add /webuiapps-prefixed copies for all routes,
// so paths like /webuiapps/diary also match the corresponding page
const prefixedRoutes: RouteObject[] = routerList
  .filter((r) => r.path)
  .map((r) => ({ ...r, path: `/webuiapps${r.path}` }));

// Standalone mode: Shell as root with desktop + floating windows
const standaloneMode = true;

const rootRouter: RouteObject[] = standaloneMode
  ? [
      {
        path: '*',
        element: (
          <React.Suspense>
            <Shell />
          </React.Suspense>
        ),
      },
    ]
  : generateRootRouter([...routerList, ...prefixedRoutes]);

export default rootRouter;
