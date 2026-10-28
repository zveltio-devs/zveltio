/**
 * The kit's page-builder blocks (ADR 0007 item 3.4): presentation only, on the
 * theme. A block's link and frame source are authored content and the kit also
 * serves hosts that do not sanitize them, so a `javascript:` URL never reaches
 * an `href` or an `<iframe>`.
 */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CallToAction from '@zveltio/ui/blocks/CallToAction.svelte';
import Figure from '@zveltio/ui/blocks/Figure.svelte';
import Heading from '@zveltio/ui/blocks/Heading.svelte';
import Hero from '@zveltio/ui/blocks/Hero.svelte';
import Icon from '@zveltio/ui/blocks/Icon.svelte';
import Stats from '@zveltio/ui/blocks/Stats.svelte';
import Video from '@zveltio/ui/blocks/Video.svelte';
import { colsClass } from '@zveltio/ui/blocks/grid';
import { linkClass, safeHref } from '@zveltio/ui/blocks/href';

describe('kit blocks', () => {
  it('keeps a link a block may carry and turns any other into #', () => {
    for (const ok of ['/a', '#top', '?q=1', './x', 'https://x.test', 'mailto:a@b.c', 'tel:+40'])
      expect(safeHref(ok)).toBe(ok);
    for (const bad of [
      'javascript:alert(1)',
      ' JaVaScRiPt:x',
      'data:text/html,x',
      '//evil.test',
      '',
      null,
    ])
      expect(safeHref(bad)).toBe('#');
    expect(linkClass('constructor')).toBe('btn btn-primary');
  });

  it('draws a hero and a call to action whose button cannot run script', () => {
    render(Hero, {
      props: {
        title: 'Welcome',
        subtitle: 'sub',
        action: { label: 'Go', href: 'javascript:alert(1)' },
      },
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go' }).getAttribute('href')).toBe('#');
    render(CallToAction, {
      props: {
        heading: 'Join',
        action: { label: 'Sign up', href: '/signup', variant: 'secondary' },
      },
    });
    const link = screen.getByRole('link', { name: 'Sign up' });
    expect(link.getAttribute('href')).toBe('/signup');
    expect(link.className).toContain('btn-secondary');
  });

  it('frames only an http(s) video', () => {
    const { container } = render(Video, { props: { url: 'javascript:alert(1)', title: 'v' } });
    expect(container.querySelector('iframe')).toBeNull();
    render(Video, { props: { url: 'https://video.test/1', title: 'Intro' } });
    expect(screen.getByTitle('Intro').getAttribute('src')).toBe('https://video.test/1');
  });

  it('names a labelled icon once and hides a decorative one', () => {
    render(Icon, { props: { path: 'M0 0', label: 'Fast' } });
    expect(screen.getAllByRole('img', { name: 'Fast' })).toHaveLength(1);
    const { container } = render(Icon, { props: { path: 'M0 0' } });
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws headings, figures and stats from plain props', () => {
    render(Heading, { props: { text: 'Section', level: 3 } });
    expect(screen.getByRole('heading', { level: 3, name: 'Section' })).toBeTruthy();
    render(Figure, { props: { src: '/a.png', alt: 'A', href: 'javascript:x', caption: 'cap' } });
    expect(screen.getByRole('img', { name: 'A' }).closest('a')?.getAttribute('href')).toBe('#');
    render(Stats, { props: { items: [{ value: '99%', label: 'Uptime' }], columns: 9 } });
    expect(screen.getByText('99%')).toBeTruthy();
    expect(colsClass(9, 4)).toBe('sm:grid-cols-6');
    expect(colsClass('x', 4)).toBe('sm:grid-cols-4');
  });
});
