import { test, expect, type Page } from '@playwright/test';

// E2E for restored nudge-card chips whose pending offer is gone.
//
// Aoi's nudge cards (idle music, cyber news, taste/preference polls) and their
// reply chips are restored from the server-persisted transcript, but the pending
// offer that gives each chip its meaning lives in this browser's localStorage.
// Tapping a chip from another browser profile, another dev-server origin, or
// after cleared storage used to arrive with no offer behind it: the chip missed
// its direct-action path, and the music one fell through to the LLM, which
// answered "I lined it up in YouTube" while nothing ever opened.
//
// Each test stubs the transcript (the e2e home is reused across runs, so a
// previous run's saved conversation must not decide the outcome) and clears
// localStorage to reproduce exactly that lost-offer state. The LLM proxy is
// stubbed to answer with a sentinel and every call is counted: these flows must
// be fully deterministic, so a single call is the regression coming back.

const YOUTUBE_APP_ID = 3;
const CYBERNEWS_APP_ID = 14;
const CONFIG_KEY = 'webuiapps-llm-config';

const PLAY_CHIP = '▶ 재생';
const MUSIC_DISMISS_CHIP = '다음에';
const RECOMMENDED_TITLE = 'E2E 8월 여름 노래모음 KPOP PLAYLIST';
// Taste-derived picks carry the channel too (aoiMusicTaste.recordYouTubePlay).
const RECOMMENDED_QUERY = `${RECOMMENDED_TITLE} - OpenRoom`;

const NEWS_CHIP = '📰 관심 있어';
const NEWS_ARTICLE_ID = 'live-e2e-chip-1';
const NEWS_HEADLINE = 'E2E SUPPLY CHAIN ATTACK POISONS BUILD PIPELINE';
const NEWS_ARTICLE_BODY = 'Full fixture body for the restored news chip test.';

// The first static preference question, mirrored here so the fixture card is
// the one the app will match against. Kept in sync by the unit tests, which
// build their fixtures from the bank itself.
const PREFERENCE_PROMPT = '요즘 가장 깊게 파고들고 싶은 기술 주제가 뭐야?';

// Deliberately ranked the way YouTube ranked the real case: the sibling upload
// first, the video Aoi actually named second. Autoplay must start the named one.
const FIXTURE_RESULTS = [
  {
    id: 'vid-wrong',
    title: 'E2E 7월 여름 노래모음 KPOP PLAYLIST',
    channel: 'OpenRoom',
    duration: '1:08:57',
    views: '245,323 views',
    published: '1 month ago',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=vid-wrong',
  },
  {
    id: 'vid-chip',
    title: RECOMMENDED_TITLE,
    channel: 'OpenRoom',
    duration: '1:02:53',
    views: '112,033 views',
    published: '2 weeks ago',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=vid-chip',
  },
];

// Live articles older than 30 minutes trigger CyberNews' live-feed refresh,
// which replaces the live set and DELETES the rotated-out files. Stamped fresh
// per run so the happy-path test is not racing that rotation; the rotation case
// gets its own test below.
function newsArticle(fetchedAt: string) {
  return {
    id: NEWS_ARTICLE_ID,
    title: NEWS_HEADLINE,
    category: 'breaking',
    summary: 'An E2E fixture article for the restored news chip.',
    content: NEWS_ARTICLE_BODY,
    imageUrl: '',
    publishedAt: fetchedAt,
    isLive: true,
    fetchedAt,
  };
}

interface CardFixture {
  id: string;
  content: string;
  suggestedReplies: string[];
}

// Stamped like a real card: the id is how a restored offer is dated, and an
// undateable music offer still plays but stops counting as mood feedback.
const MUSIC_CARD: CardFixture = {
  id: `aoi-idle-music-${Date.now()}`,
  content: `늦은 시간이라 조용하네. 은은한 사운드 하나 깔아줄까?\n🎵 추천 (네 취향 반영): "${RECOMMENDED_QUERY}"`,
  suggestedReplies: [PLAY_CHIP, MUSIC_DISMISS_CHIP],
};

// News cards are emitted as `aoi-news-<epoch ms>`. Once localStorage is out of
// the picture that stamp is the only record of when the offer was made, and the
// app ages the restored offer by it, so the fixture carries a real one.
function newsCard(offeredAt: number): CardFixture {
  return {
    id: `aoi-news-${offeredAt}`,
    content: `📰 새 사이버보안 뉴스가 눈에 띄네: "${NEWS_HEADLINE}". 자세히 볼래?`,
    suggestedReplies: [NEWS_CHIP, '지금은 됐어'],
  };
}

// The gap in the reported incident: the card sat in the transcript for close to
// four days before the chip was tapped.
const STALE_NEWS_CARD_AGE_MS = 91 * 60 * 60 * 1000;

// The first taste-poll question, mirrored from the bank the app matches against.
const TASTE_PROMPT = '음악 취향 하나만 물어볼게. 배경으로 깔 때 어떤 분위기가 제일 좋아?';
const TASTE_CHIP = '잔잔한 로파이·칠';
const TASTE_POLL_STORAGE_KEY = 'aoi-pending-taste-poll-v1';

const TASTE_POLL_CARD: CardFixture = {
  id: 'aoi-taste-poll-e2e',
  content: TASTE_PROMPT,
  suggestedReplies: [
    TASTE_CHIP,
    '신나는 팝·케이팝',
    '집중용 앰비언트·인스트루멘털',
    '그때그때 달라',
  ],
};

// A card whose prompt is no longer in the bank -- what a deploy that reworded or
// dropped a question leaves in an already-posted transcript. Recovery cannot
// rebuild the poll from it, so the answer path has only the stored copy to go on.
const STALE_TASTE_POLL_CARD: CardFixture = {
  id: 'aoi-taste-poll-e2e-stale',
  content: '예전에 쓰던, 지금은 뱅크에 없는 취향 질문이야. 어느 쪽이 좋아?',
  suggestedReplies: [TASTE_CHIP, '신나는 팝·케이팝'],
};

// A proactive trend card. Its follow-up chips are backed by a context object
// that only ever lived in memory, so a reload left them pointing at nothing:
// the tap reached the model as bare prose with no idea which trend it was about.
const TREND_SOURCES_CHIP = '출처 보여줘';
const TREND_TITLE = 'A NEW ANTI-TAMPER BYPASS IS CIRCULATING';
const TREND_SOURCE_URL = 'https://example.test/advisory';
const TREND_FOLLOW_UP_STORAGE_KEY = 'aoi-trend-follow-up-contexts-v1';

const TREND_CARD: CardFixture = {
  id: 'aoi-trend-direct-e2e-snapshot',
  content: `요즘 보던 주제에서 이게 눈에 띄어: ${TREND_TITLE}`,
  suggestedReplies: [TREND_SOURCES_CHIP, '나중에'],
};

// An agenda card. Its chips are backed the same way the trend card's are, and
// were lost the same way; the follow-up answer is built entirely from the stored
// nudge, so a restored context is the only thing that can produce it.
const AGENDA_APPROVAL_CHIP = 'Review the approval gate';
const AGENDA_EVIDENCE_REF = 'agenda-proposal-7-evidence';
const AGENDA_FOLLOW_UP_STORAGE_KEY = 'aoi-agenda-follow-up-contexts-v1';

const AGENDA_CARD: CardFixture = {
  id: 'aoi-agenda-direct-e2e-proposal-7',
  content: '승인 대기 중인 제안이 하나 있어. 지금 볼래?',
  suggestedReplies: [AGENDA_APPROVAL_CHIP, '나중에'],
};

const PREFERENCE_CARD: CardFixture = {
  id: 'aoi-preference-poll-e2e',
  content: PREFERENCE_PROMPT,
  suggestedReplies: [
    'Windows 커널·드라이버 내부',
    '안티치트·게임 보안',
    '리버스 엔지니어링',
    'TPM·하드웨어 기반 검증',
  ],
};

function transcriptWith(card: CardFixture) {
  const message = { ...card, role: 'assistant' };
  return {
    version: 1,
    savedAt: 1,
    messages: [message],
    chatHistory: [{ role: 'assistant', content: card.content }],
    suggestedReplies: card.suggestedReplies,
  };
}

// Serve the fixture transcript for the chat read, and the fixture article for
// the CyberNews store. Every other session-data request (including saves)
// passes through to the real isolated server.
// Set by stubSessionData when the app asks for its transcript. Follow-up
// contexts are stamped with the session they belong to, so a test that seeds one
// has to use the path the app is really running under.
let observedSessionPath = '';

async function stubSessionData(
  page: Page,
  card: CardFixture,
  articleFetchedAt: string = new Date().toISOString(),
): Promise<void> {
  await page.route('**/api/session-data**', async (route) => {
    const request = route.request();
    const url = decodeURIComponent(request.url());
    if (request.method() !== 'GET') {
      await route.continue();
      return;
    }
    if (url.includes('chat/chat.json')) {
      observedSessionPath = url.match(/[?&]path=(.*)\/chat\/chat\.json/)?.[1] ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(transcriptWith(card)),
      });
      return;
    }
    const articlesDir = 'apps/cyberNews/data/articles';
    if (url.includes(`${articlesDir}/${NEWS_ARTICLE_ID}.json`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(newsArticle(articleFetchedAt)),
      });
      return;
    }
    if (url.includes(articlesDir) && url.includes('action=list')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [{ path: `${articlesDir}/${NEWS_ARTICLE_ID}.json`, type: 0, size: 512 }],
          not_exists: false,
        }),
      });
      return;
    }
    await route.continue();
  });
}

test.describe('Aoi nudge chips after the pending offer is lost', () => {
  let llmCallCount = 0;

  test.beforeEach(async ({ page }) => {
    llmCallCount = 0;
    observedSessionPath = '';
    // A usable model config is required to reach the direct-action paths, but no
    // request may actually be made -- every call is counted and asserted zero.
    await page.addInitScript((configKey) => {
      localStorage.clear();
      localStorage.setItem(
        configKey,
        JSON.stringify({
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://mock-llm.test/v1',
          model: 'gpt-4',
        }),
      );
    }, CONFIG_KEY);
    await page.route('**/api/llm-proxy', async (route) => {
      const body = route.request().postDataJSON() as {
        tools?: Array<{ function: { name: string } }>;
      };
      // The intent classifier is a separate, tiny call and is NOT what these
      // tests forbid. What they forbid is a conversation turn inventing an
      // answer, so only those are counted.
      if ((body?.tools ?? []).some((tool) => tool.function.name === 'resolve_music_intent')) {
        await route.fulfill({
          json: {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_intent',
                      type: 'function',
                      function: {
                        name: 'resolve_music_intent',
                        arguments: JSON.stringify({
                          action: 'play_candidate',
                          candidate_id: 1,
                          confidence: 'high',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        });
        return;
      }
      llmCallCount += 1;
      await route.fulfill({
        json: { choices: [{ message: { content: 'LLM MUST NOT BE CALLED' } }] },
      });
    });
    await page.route('**/api/youtube-search**', (route) =>
      route.fulfill({ json: { results: FIXTURE_RESULTS } }),
    );
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://i.ytimg.com/**', (route) => route.abort());
    // Empty live feed by default: syncLiveArticles bails on an empty response
    // and keeps what is on disk, so the fixture article survives. The rotation
    // test overrides this with a real item.
    await page.route('**/api/cybernews/live**', (route) =>
      route.fulfill({ json: { provider: 'e2e', fetchedAt: new Date().toISOString(), items: [] } }),
    );
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
  });

  async function tapChip(page: Page, hasText: string): Promise<void> {
    const chip = page.getByTestId('suggested-reply').filter({ hasText });
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await chip.click();
  }

  test('the music play chip recovers its pick and opens it in the YouTube app', async ({
    page,
  }) => {
    await stubSessionData(page, MUSIC_CARD);
    await page.goto('/');
    await tapChip(page, '재생');

    // The chip must open the in-app YouTube window and run the recommended
    // query -- this is the whole point of the fix.
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('yt-result-card-vid-chip')).toBeVisible({ timeout: 30_000 });
    // autoplay: '1' loads a video into the player -- and it must be the one the
    // card named, not the higher-ranked sibling sitting above it in the list.
    await expect(page.getByTestId('yt-player-title')).toHaveText(RECOMMENDED_TITLE);
    // The search box must show what is actually playing. A cold open applies
    // state.json after the agent action lands, so this catches the stale query
    // being restored over the one Aoi just ran.
    await expect(page.getByTestId('yt-search-input')).toHaveValue(RECOMMENDED_QUERY);

    // And the ack must come from the deterministic path, not a model turn.
    await expect(page.getByTestId('chat-messages')).toContainText(RECOMMENDED_QUERY);
    expect(llmCallCount).toBe(0);
  });

  test('names what it really started when the recommended video is not in the results', async ({
    page,
  }) => {
    // The named video is gone (taken down, never surfaced). Something still
    // plays -- but the ack must say WHICH something, instead of announcing the
    // query as if that were what is on.
    const substitute = 'E2E UNRELATED FALLBACK MIX';
    await page.route('**/api/youtube-search**', (route) =>
      route.fulfill({
        json: {
          results: [{ ...FIXTURE_RESULTS[0], id: 'vid-sub', title: substitute }],
        },
      }),
    );
    await stubSessionData(page, MUSIC_CARD);
    await page.goto('/');
    await tapChip(page, '재생');

    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-player-title')).toHaveText(substitute, { timeout: 30_000 });

    const messages = page.getByTestId('chat-messages');
    await expect(messages).toContainText(substitute);
    // The exact-match wording claims the named pick is playing; it must not be
    // used here.
    await expect(messages).not.toContainText('재생 준비해뒀어');
    expect(llmCallCount).toBe(0);
  });

  test('replays the pick Aoi just started when asked for it again', async ({ page }) => {
    // Reported follow-up: after the play chip started something, "다시 틀어줘"
    // was parsed as a search for the adverb ('"다시" 유튜브에서 틀어볼게.'), and
    // the correction after it reached the LLM, which announced playback it
    // never dispatched.
    await stubSessionData(page, MUSIC_CARD);
    await page.goto('/');
    await tapChip(page, '재생');
    await expect(page.getByTestId('yt-player-title')).toHaveText(RECOMMENDED_TITLE, {
      timeout: 30_000,
    });

    // Close the window so a replay has to genuinely re-dispatch to reopen it.
    await page.getByTestId(`window-close-${YOUTUBE_APP_ID}`).click();
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toHaveCount(0);

    await page.getByTestId('chat-input').fill('다시 틀어줘');
    await page.getByTestId('send-btn').click();

    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-player-title')).toHaveText(RECOMMENDED_TITLE, {
      timeout: 30_000,
    });
    // Never a search for the adverb itself.
    await expect(page.getByTestId('yt-search-input')).not.toHaveValue('다시');
    expect(llmCallCount).toBe(0);
  });

  test('the music dismiss chip answers as a dismissal instead of reaching the model', async ({
    page,
  }) => {
    await stubSessionData(page, MUSIC_CARD);
    await page.goto('/');
    await tapChip(page, MUSIC_DISMISS_CHIP);

    await expect(page.getByTestId('chat-messages')).toContainText('알겠어. 필요하면 말해줘.');
    // A dismissal opens nothing.
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toHaveCount(0);
    expect(llmCallCount).toBe(0);
  });

  test('the news chip recovers its article and opens it in CyberNews', async ({ page }) => {
    await stubSessionData(page, newsCard(Date.now()));
    await page.goto('/');
    await tapChip(page, '관심 있어');

    await expect(page.getByTestId(`app-window-${CYBERNEWS_APP_ID}`)).toBeVisible({
      timeout: 30_000,
    });
    // The article BODY only renders in the detail view, so this distinguishes
    // "VIEW_ARTICLE actually opened it" from "the feed list happens to show
    // that headline".
    await expect(page.getByTestId(`app-window-${CYBERNEWS_APP_ID}`)).toContainText(
      NEWS_ARTICLE_BODY,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('chat-messages')).toContainText('CyberNews에서');
    expect(llmCallCount).toBe(0);
  });

  test('says so honestly when the offered article is gone instead of claiming an open', async ({
    page,
  }) => {
    // A stale live article is rotated out (and its file deleted) by CyberNews'
    // own refresh, so VIEW_ARTICLE genuinely cannot find it. dispatchAgentAction
    // reports that by RESOLVING with "error: ...", never by throwing -- an ack
    // gated only on exceptions would announce an article that never opened.
    // A live feed that does not contain the offered article: CyberNews replaces
    // its live set with this one and deletes the rotated-out file.
    await page.route('**/api/cybernews/live**', (route) =>
      route.fulfill({
        json: {
          provider: 'e2e',
          fetchedAt: new Date().toISOString(),
          items: [
            {
              title: 'A COMPLETELY DIFFERENT HEADLINE',
              url: 'https://example.test/other',
              summary: 'Replaces the offered article.',
              imageUrl: '',
              sourceName: 'E2E',
              publishedAt: new Date().toISOString(),
              category: 'breaking',
            },
          ],
        },
      }),
    );
    await stubSessionData(page, newsCard(Date.now()), '2020-01-01T00:00:00.000Z');
    await page.goto('/');
    await tapChip(page, '관심 있어');

    // Says the article rolled off the feed, and backs the offer to pick another
    // one by actually putting CyberNews on the current list.
    await expect(page.getByTestId('chat-messages')).toContainText('피드에서 내려갔어', {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`app-window-${CYBERNEWS_APP_ID}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('chat-messages')).not.toContainText('CyberNews에서 "');
    expect(llmCallCount).toBe(0);
  });

  // The reported failure: a card tapped days later. The article had long since
  // been pruned, but the chip was still armed, so the tap dispatched
  // VIEW_ARTICLE for a deleted file and answered with a generic open error that
  // told the user to go look in an app where the article no longer was.
  test('a news chip older than the offer TTL never dispatches a doomed open', async ({ page }) => {
    // The article is present and fresh on disk: only the offer's age disarms
    // the chip, so this cannot pass by the article being missing.
    await stubSessionData(page, newsCard(Date.now() - STALE_NEWS_CARD_AGE_MS));
    await page.goto('/');
    await tapChip(page, '관심 있어');

    await expect(page.getByTestId('chat-messages')).toContainText('피드에서 내려갔어', {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`app-window-${CYBERNEWS_APP_ID}`)).toBeVisible({
      timeout: 30_000,
    });
    // The list view, not the article detail. Had the chip still dispatched
    // VIEW_ARTICLE it would have succeeded here -- the article is on disk -- and
    // both the body and the "CyberNews에서" open ack would be showing.
    await expect(page.getByTestId(`app-window-${CYBERNEWS_APP_ID}`)).not.toContainText(
      NEWS_ARTICLE_BODY,
    );
    await expect(page.getByTestId('chat-messages')).not.toContainText('CyberNews에서 "');
    expect(llmCallCount).toBe(0);
  });

  test('a taste poll chip is recorded as an answer instead of reaching the model', async ({
    page,
  }) => {
    await stubSessionData(page, TASTE_POLL_CARD);
    await page.goto('/');
    await tapChip(page, TASTE_CHIP);

    await expect(page.getByTestId('chat-messages')).toContainText(TASTE_CHIP);
    await expect(page.getByTestId('chat-messages')).toContainText('다음 추천부터 반영할게');
    expect(llmCallCount).toBe(0);
  });

  // The false claim this guard removes: recordTasteAnswer drops an answer whose
  // question is no longer in the bank, and the ack said "I'll remember that"
  // anyway. Nothing was written, so nothing may be claimed.
  test('a taste poll chip whose question is gone says so instead of claiming memory', async ({
    page,
  }) => {
    // Seeded after the beforeEach init script clears storage: a poll written by
    // an earlier deploy, kept only as strings and never re-checked against the
    // bank. Its labels match the card, so the tap is a real answer -- to a
    // question that no longer exists.
    await page.addInitScript(
      ([key, label]) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            questionId: 'vibe_removed_by_deploy',
            options: [{ id: 'calm_lofi', label }],
          }),
        );
      },
      [TASTE_POLL_STORAGE_KEY, TASTE_CHIP],
    );
    await stubSessionData(page, STALE_TASTE_POLL_CARD);
    await page.goto('/');
    await tapChip(page, TASTE_CHIP);

    await expect(page.getByTestId('chat-messages')).toContainText('저장하지 못했어', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('chat-messages')).not.toContainText('기억해둘게');
    expect(llmCallCount).toBe(0);
  });

  test('a trend follow-up chip still knows its trend after a reload', async ({ page }) => {
    await stubSessionData(page, TREND_CARD);
    await page.goto('/');
    // The chip proves the transcript is restored, which is also when the app has
    // told us the session path the context has to be stamped with.
    await expect(
      page.getByTestId('suggested-reply').filter({ hasText: TREND_SOURCES_CHIP }),
    ).toBeVisible({ timeout: 30_000 });
    expect(observedSessionPath).not.toBe('');

    // Seeded as an init script, not an evaluate: the beforeEach init script
    // clears storage on every navigation, and this has to land after it on the
    // reload below -- which is exactly the ordering a real page load has.
    await page.addInitScript(
      ([storageKey, sessionPath, prompt, title, url]) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            version: 1,
            sessionPath,
            contexts: [
              {
                version: 1,
                prompt,
                cardId: 'aoi-trend-direct-e2e-snapshot',
                snapshotId: 'e2e-snapshot',
                topicId: 'topic-kernel',
                topicLabel: 'Windows kernel security',
                title,
                myTake: 'Worth reading before the next driver review.',
                suggestedNextAction: 'Read the advisory.',
                sourceHosts: ['example.test'],
                sources: [
                  {
                    title: 'The advisory',
                    url,
                    host: 'example.test',
                    snippet: 'Details of the bypass.',
                  },
                ],
                evidenceRefs: ['e2e-snapshot#1'],
                createdAt: Date.now(),
              },
            ],
          }),
        );
      },
      [
        TREND_FOLLOW_UP_STORAGE_KEY,
        observedSessionPath,
        TREND_SOURCES_CHIP,
        TREND_TITLE,
        TREND_SOURCE_URL,
      ],
    );
    await page.reload();
    await tapChip(page, TREND_SOURCES_CHIP);

    // The stored sources are listed deterministically, naming the trend the chip
    // belongs to. Without the restored context this message cannot exist and the
    // chip goes to the model instead.
    await expect(page.getByTestId('chat-messages')).toContainText(TREND_SOURCE_URL, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('chat-messages')).toContainText(TREND_TITLE);
    expect(llmCallCount).toBe(0);
  });

  test('an agenda follow-up chip still knows its proposal after a reload', async ({ page }) => {
    await stubSessionData(page, AGENDA_CARD);
    await page.goto('/');
    await expect(
      page.getByTestId('suggested-reply').filter({ hasText: AGENDA_APPROVAL_CHIP }),
    ).toBeVisible({ timeout: 30_000 });
    expect(observedSessionPath).not.toBe('');

    await page.addInitScript(
      ([storageKey, sessionPath, prompt, evidenceRef]) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            version: 1,
            sessionPath,
            contexts: [
              {
                prompt,
                nudge: {
                  dedupeKey: 'proposal-7:approval_waiting',
                  reason: 'approval_waiting',
                  proposalId: 'proposal-7',
                  chatText: '승인 대기 중인 제안이 하나 있어.',
                  suggestedReplies: [prompt, '나중에'],
                  evidenceRefs: [evidenceRef],
                },
                createdAt: Date.now(),
              },
            ],
          }),
        );
      },
      [
        AGENDA_FOLLOW_UP_STORAGE_KEY,
        observedSessionPath,
        AGENDA_APPROVAL_CHIP,
        AGENDA_EVIDENCE_REF,
      ],
    );
    await page.reload();
    await tapChip(page, AGENDA_APPROVAL_CHIP);

    // The approval-gate answer is assembled from the stored nudge, so it can
    // only exist if the context came back. The evidence ref is the half that
    // could not have come from a fallback: it was in the seeded nudge alone.
    await expect(page.getByTestId('chat-messages')).toContainText('Approval gate:', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('chat-messages')).toContainText(AGENDA_EVIDENCE_REF);
    expect(llmCallCount).toBe(0);
  });

  test('a preference poll chip is recorded as an answer instead of reaching the model', async ({
    page,
  }) => {
    await stubSessionData(page, PREFERENCE_CARD);
    await page.goto('/');
    await tapChip(page, 'Windows 커널·드라이버 내부');

    // The deterministic ack confirms the exact choice back and says it is kept.
    await expect(page.getByTestId('chat-messages')).toContainText('Windows 커널·드라이버 내부');
    await expect(page.getByTestId('chat-messages')).toContainText('기억해둘게');
    expect(llmCallCount).toBe(0);
  });
});
