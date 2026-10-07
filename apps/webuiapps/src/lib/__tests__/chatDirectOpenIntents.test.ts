import { describe, expect, it } from 'vitest';

import {
  extractNameMemory,
  isDirectIdeOpenIntent,
  isDirectKiraOpenIntent,
  isDirectPeAnalystOpenIntent,
  isDirectYouTubeOpenIntent,
} from '../chatDirectOpenIntents';

describe('direct open intents', () => {
  it('opens on short, explicit requests', () => {
    for (const text of [
      'open youtube',
      'Open YouTube please',
      'can you open the music app?',
      '유튜브 열어줘',
      '유튜브 좀 열어 주세요',
      'youtube 실행해',
    ]) {
      expect(isDirectYouTubeOpenIntent(text), text).toBe(true);
    }
    for (const text of [
      'open kira',
      'launch the kanban board',
      '키라 실행해',
      '칸반 보드 띄워줘',
    ]) {
      expect(isDirectKiraOpenIntent(text), text).toBe(true);
    }
    for (const text of ['open the IDE', "start Aoi's IDE", '코드 에디터 열어줘', '에디터 켜줘']) {
      expect(isDirectIdeOpenIntent(text), text).toBe(true);
    }
    for (const text of [
      'open PE Analyst',
      'PE 분석기 열어줘',
      'I want to analyze a PE file',
      "let's inspect this pe binary",
      'PE 파일 분석하고 싶어',
      'pe 분석해 줘',
    ]) {
      expect(isDirectPeAnalystOpenIntent(text), text).toBe(true);
    }
  });

  it('leaves ordinary questions to the model', () => {
    // Every one of these used to open an app and drop the question.
    const youtube = ['I saw a YouTube video showing a new trick', 'what is youtube premium?'];
    const kira = [
      'What is the difference between Scrum and Kanban?',
      '오늘 할 일 보여줘',
      'project management tips for small teams',
    ];
    const ide = ["Let's start a side project", 'Can you open the guide?', 'run it outside'];
    const pe = [
      'Can you review this type error?',
      'Analyze the scope of this change',
      'TypeScript 타입 분석하고 싶어',
      '로그 분석기 보여줘',
    ];
    for (const text of youtube) expect(isDirectYouTubeOpenIntent(text), text).toBe(false);
    for (const text of kira) expect(isDirectKiraOpenIntent(text), text).toBe(false);
    for (const text of ide) expect(isDirectIdeOpenIntent(text), text).toBe(false);
    for (const text of pe) expect(isDirectPeAnalystOpenIntent(text), text).toBe(false);
  });

  it('leaves requests that carry more than an open to the model', () => {
    // The fast path would open the app and drop "and play lofi".
    expect(isDirectYouTubeOpenIntent('open youtube and play some lofi beats')).toBe(false);
    expect(isDirectYouTubeOpenIntent(`open youtube ${'please '.repeat(20)}`)).toBe(false);
    expect(isDirectYouTubeOpenIntent('   ')).toBe(false);
  });
});

describe('extractNameMemory', () => {
  it('reads names that are stated outright', () => {
    expect(extractNameMemory('My name is Alex')).toBe("The user's name is Alex.");
    expect(extractNameMemory('Hi! my name is Mary Jane Watson, nice to meet you')).toBe(
      "The user's name is Mary Jane Watson.",
    );
    expect(extractNameMemory('my name is Alex and I like jazz')).toBe("The user's name is Alex.");
    expect(extractNameMemory('Please call me Sam.')).toBe("The user's name is Sam.");
    expect(extractNameMemory('제 이름은 철수입니다')).toBe("The user's name is 철수.");
    expect(extractNameMemory('내 이름은 영희야')).toBe("The user's name is 영희.");
    expect(extractNameMemory('제 이름은 미야')).toBe("The user's name is 미야.");
    expect(extractNameMemory('저를 민준이라고 불러줘')).toBe("The user's name is 민준.");
  });

  it('does not turn states or roles into a name', () => {
    for (const text of [
      "I'm tired",
      'I am going to bed now',
      "I'm Korean",
      '나는 학생이야',
      '나는 개발자야',
      'my name is',
      'my name is 123',
      '',
    ]) {
      expect(extractNameMemory(text), text).toBeNull();
    }
  });
});
