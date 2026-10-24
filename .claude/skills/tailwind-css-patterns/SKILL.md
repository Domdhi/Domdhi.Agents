---
name: tailwind-css-patterns
description: "Use WHEN styling React/Vue/Svelte components with Tailwind CSS, building responsive layouts, or implementing a Tailwind-based design system. Triggers: tailwind, css, responsive, utility-first, design system, dark mode"
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [tailwind, css, responsive-design, utility-first, design-system]
user-invocable: false
allowed-tools: Read Grep Glob
---

<!-- Generated from .agents/skills/tailwind-css-patterns/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Tailwind CSS Development Patterns

## Overview

Expert guide for building modern, responsive user interfaces with Tailwind CSS utility-first framework. Covers v4.1+ features including CSS-first configuration, custom utilities, and enhanced developer experience.

## When to Use

- Styling React/HTML components with utility classes
- Building responsive layouts with breakpoints
- Implementing flexbox and grid layouts
- Managing spacing, colors, and typography
- Creating custom design systems
- Optimizing for mobile-first design
- Building dark mode interfaces

## Instructions

1. **Start Mobile-First**: Write base styles for mobile, add responsive prefixes for larger screens
2. **Use Design Tokens**: Leverage Tailwind's spacing, color, and typography scales
3. **Compose Utilities**: Combine multiple utilities for complex styles
4. **Extract Components**: Create reusable component classes for repeated patterns
5. **Configure Theme**: Customize design tokens in tailwind.config.js
6. **Optimize for Production**: Ensure content paths are configured for CSS purging
7. **Test Responsive**: Verify layouts at all breakpoint sizes

## Examples

### Responsive Card Component

```tsx
function ProductCard({ product }: { product: Product }) {
  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden
                    sm:flex sm:max-w-2xl">
      <img
        className="h-48 w-full object-cover sm:h-auto sm:w-48"
        src={product.image}
        alt={product.name}
      />
      <div className="p-6">
        <h3 className="text-lg font-semibold text-gray-900">
          {product.name}
        </h3>
        <p className="mt-2 text-gray-600">
          {product.description}
        </p>
        <button className="mt-4 px-4 py-2 bg-indigo-600 text-white
                          rounded-lg hover:bg-indigo-700 transition">
          Add to Cart
        </button>
      </div>
    </div>
  );
}
```

## Constraints and Warnings

- **Class Proliferation**: Long class strings can reduce readability; extract components when needed
- **Purge Configuration**: Must configure content paths correctly for production builds
- **Arbitrary Values**: Use sparingly; prefer design tokens for consistency
- **Specificity Issues**: Avoid @apply with complex selectors
- **Inline styles silently defeat breakpoint classes**: in Tailwind v4, setting a property via `style={{...}}` on an element that also carries responsive breakpoint classes (`min-[]:`/`max-[]:`, etc.) disables ALL of those variants — inline styles win specificity over any class-based rule, including ones inside media queries. The breakpoint classes still appear in `className` and look correct in review, but never take effect. Most common with `gridTemplateColumns` and `position: sticky`. Move the value into a class (arbitrary value or a CSS variable) instead of `style={{}}` if it needs to vary by breakpoint.
- **Dark Mode**: Requires proper configuration (class or media strategy)
- **JIT Mode**: Some dynamic patterns may not be detected; use safelist if needed
- **Browser Support**: Check Tailwind docs for browser compatibility

## Core Concepts

### Utility-First Approach

Apply styles directly in markup using utility classes:

```html
<button class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">
  Click me
</button>
```

### Responsive Design

Mobile-first breakpoints with prefixes:

```html
<div class="w-full md:w-1/2 lg:w-1/3">
  <!-- Full width on mobile, half on tablet, third on desktop -->
</div>
```

Breakpoint prefixes:
- `sm:` - 640px and above
- `md:` - 768px and above
- `lg:` - 1024px and above
- `xl:` - 1280px and above
- `2xl:` - 1536px and above

> Load `references/patterns.md` when implementing component patterns, responsive layouts, interactive states, animations, or performance optimization.
> Load `references/configuration.md` when configuring Tailwind (CSS-first, JS, Vite, v4.1 features, or accessibility guidelines).

## Layout Utilities

### Flexbox Layouts

Basic flex container:

```html
<div class="flex items-center justify-between">
  <div>Left</div>
  <div>Center</div>
  <div>Right</div>
</div>
```

Responsive flex direction:

```html
<div class="flex flex-col md:flex-row gap-4">
  <div class="flex-1">Item 1</div>
  <div class="flex-1">Item 2</div>
  <div class="flex-1">Item 3</div>
</div>
```

Common flex patterns:

```html
<!-- Center content -->
<div class="flex items-center justify-center min-h-screen">
  <div>Centered Content</div>
</div>

<!-- Space between items -->
<div class="flex justify-between items-center">
  <span>Left</span>
  <span>Right</span>
</div>

<!-- Vertical stack with gap -->
<div class="flex flex-col gap-4">
  <div>Item 1</div>
  <div>Item 2</div>
</div>
```

### Grid Layouts

Basic grid:

```html
<div class="grid grid-cols-3 gap-4">
  <div>Column 1</div>
  <div>Column 2</div>
  <div>Column 3</div>
</div>
```

Responsive grid:

```html
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
  <!-- 1 column mobile, 2 tablet, 4 desktop -->
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
  <div>Item 4</div>
</div>
```

Auto-fit columns:

```html
<div class="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-4">
  <!-- Automatically fit columns based on container width -->
</div>
```

### Container & Max Width

Centered container with max width:

```html
<div class="container mx-auto px-4 max-w-7xl">
  <!-- Centered content with padding -->
</div>
```

Responsive max width:

```html
<div class="w-full max-w-md mx-auto">
  <!-- Max 448px width, centered -->
</div>
```

## Dark Mode

### Basic Dark Mode Support

```html
<div class="bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
  <h1 class="text-gray-900 dark:text-white">Title</h1>
  <p class="text-gray-600 dark:text-gray-400">Description</p>
</div>
```

Enable dark mode in tailwind.config.js:

```javascript
module.exports = {
  darkMode: 'class', // or 'media'
  // ...
}
```

## Best Practices

1. **Mobile-First**: Start with mobile styles, add responsive prefixes for larger screens
2. **Consistent Spacing**: Use Tailwind's spacing scale (4, 8, 12, 16, etc.)
3. **Color Palette**: Stick to Tailwind's color system for consistency
4. **Component Extraction**: Extract repeated patterns into components
5. **Utility Composition**: Prefer utility classes over @apply for better maintainability
6. **Semantic HTML**: Use proper HTML elements with Tailwind classes
7. **Performance**: Configure content paths correctly for optimal CSS purging
8. **Accessibility**: Include focus styles, ARIA labels, and respect user preferences
9. **CSS-First Config**: Use @theme directive for v4.1+ instead of JavaScript config
10. **Custom Utilities**: Create reusable utilities with @utility for complex patterns

## References

- Tailwind CSS Docs: https://tailwindcss.com/docs
- Tailwind UI: https://tailwindui.com
- Tailwind Play: https://play.tailwindcss.com
- Headless UI: https://headlessui.com

---

## Project-Specific: UI Library Coexistence

> This section is added by `/specialize` or `/optimize-agents` when the project uses Tailwind alongside a component library (e.g., PrimeNG, Shadcn, Material UI).
> When no project context exists, the generic Tailwind patterns above apply.
>
> To populate this section, run `/specialize --fix` after architecture docs are complete.
