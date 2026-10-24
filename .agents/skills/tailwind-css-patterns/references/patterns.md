# Tailwind Patterns Reference

## Spacing

### Padding & Margin

Uniform spacing:

```html
<div class="p-4">Padding all sides</div>
<div class="m-4">Margin all sides</div>
```

Individual sides:

```html
<div class="pt-4 pr-8 pb-4 pl-8">
  <!-- Top 1rem, Right 2rem, Bottom 1rem, Left 2rem -->
</div>
```

Axis-based spacing:

```html
<div class="px-4 py-8">
  <!-- Horizontal padding 1rem, Vertical padding 2rem -->
</div>
```

Responsive spacing:

```html
<div class="p-4 md:p-8 lg:p-12">
  <!-- Increases padding at larger breakpoints -->
</div>
```

Space between children:

```html
<div class="space-y-4">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</div>
```

## Typography

### Font Size & Weight

```html
<h1 class="text-4xl font-bold">Large Heading</h1>
<h2 class="text-2xl font-semibold">Subheading</h2>
<p class="text-base font-normal">Body text</p>
<small class="text-sm text-gray-600">Small text</small>
```

Responsive typography:

```html
<h1 class="text-2xl md:text-4xl lg:text-6xl font-bold">
  Responsive Heading
</h1>
```

### Line Height & Letter Spacing

```html
<p class="leading-relaxed tracking-wide">
  Text with relaxed line height and wide letter spacing
</p>
```

### Text Alignment

```html
<p class="text-left md:text-center">
  Left aligned on mobile, centered on tablet+
</p>
```

## Colors

### Background Colors

```html
<div class="bg-blue-500">Blue background</div>
<div class="bg-gray-100">Light gray background</div>
<div class="bg-gradient-to-r from-blue-500 to-purple-600">
  Gradient background
</div>
```

### Text Colors

```html
<p class="text-gray-900">Dark text</p>
<p class="text-blue-600">Blue text</p>
<p class="text-red-500">Error text</p>
```

### Opacity

```html
<div class="bg-blue-500 bg-opacity-50">
  Semi-transparent blue
</div>
```

## Interactive States

### Hover States

```html
<button class="bg-blue-500 hover:bg-blue-700 transition">
  Hover me
</button>

<a class="text-blue-600 hover:text-blue-800 hover:underline">
  Hover link
</a>
```

### Focus States

```html
<input class="border border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none">
```

### Active & Disabled States

```html
<button class="bg-blue-500 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed">
  Button
</button>
```

### Group Hover

```html
<div class="group">
  <img class="group-hover:opacity-75" src="image.jpg" />
  <p class="group-hover:text-blue-600">Hover the parent</p>
</div>
```

## Component Patterns

### Card Component

```html
<div class="bg-white rounded-lg shadow-lg overflow-hidden">
  <img class="w-full h-48 object-cover" src="image.jpg" alt="Card image" />
  <div class="p-6">
    <h3 class="text-xl font-bold mb-2">Card Title</h3>
    <p class="text-gray-700 mb-4">Card description text goes here.</p>
    <button class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">
      Action
    </button>
  </div>
</div>
```

### Responsive User Card

```html
<div class="max-w-sm mx-auto bg-white rounded-xl shadow-lg overflow-hidden sm:flex sm:max-w-2xl">
  <img class="h-48 w-full object-cover sm:h-auto sm:w-48" 
       src="profile.jpg" 
       alt="Profile" />
  <div class="p-8">
    <div class="uppercase tracking-wide text-sm text-indigo-500 font-semibold">
      Product Engineer
    </div>
    <h2 class="mt-1 text-xl font-semibold text-gray-900">
      John Doe
    </h2>
    <p class="mt-2 text-gray-500">
      Building amazing products with modern technology.
    </p>
    <button class="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition">
      Contact
    </button>
  </div>
</div>
```

### Navigation Bar

```html
<nav class="bg-white shadow-lg">
  <div class="container mx-auto px-4">
    <div class="flex justify-between items-center h-16">
      <div class="flex items-center">
        <a href="#" class="text-xl font-bold text-gray-800">Logo</a>
      </div>
      <div class="hidden md:flex space-x-8">
        <a href="#" class="text-gray-700 hover:text-blue-600 transition">Home</a>
        <a href="#" class="text-gray-700 hover:text-blue-600 transition">About</a>
        <a href="#" class="text-gray-700 hover:text-blue-600 transition">Services</a>
        <a href="#" class="text-gray-700 hover:text-blue-600 transition">Contact</a>
      </div>
      <button class="md:hidden">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
        </svg>
      </button>
    </div>
  </div>
</nav>
```

### Form Elements

```html
<form class="space-y-6 max-w-md mx-auto">
  <div>
    <label class="block text-sm font-medium text-gray-700 mb-2">
      Email
    </label>
    <input 
      type="email" 
      class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      placeholder="you@example.com"
    />
  </div>
  
  <div>
    <label class="block text-sm font-medium text-gray-700 mb-2">
      Password
    </label>
    <input 
      type="password" 
      class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
    />
  </div>
  
  <div class="flex items-center">
    <input type="checkbox" class="mr-2" />
    <label class="text-sm text-gray-600">Remember me</label>
  </div>
  
  <button 
    type="submit"
    class="w-full bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg hover:bg-blue-700 transition"
  >
    Sign In
  </button>
</form>
```

### Modal/Dialog

```html
<div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
    <div class="flex justify-between items-center mb-4">
      <h3 class="text-xl font-bold">Modal Title</h3>
      <button class="text-gray-500 hover:text-gray-700">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>
    </div>
    <p class="text-gray-700 mb-6">
      Modal content goes here.
    </p>
    <div class="flex justify-end space-x-4">
      <button class="px-4 py-2 text-gray-600 hover:text-gray-800">
        Cancel
      </button>
      <button class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
        Confirm
      </button>
    </div>
  </div>
</div>
```

## Responsive Design Patterns

### Mobile-First Responsive Layout

```html
<div class="container mx-auto px-4">
  <!-- Hero Section -->
  <div class="flex flex-col md:flex-row items-center gap-8 py-12">
    <div class="flex-1">
      <h1 class="text-3xl md:text-5xl font-bold mb-4">
        Welcome to Our Site
      </h1>
      <p class="text-lg text-gray-600 mb-6">
        Build amazing things with Tailwind CSS
      </p>
      <button class="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700">
        Get Started
      </button>
    </div>
    <div class="flex-1">
      <img src="hero.jpg" class="w-full rounded-lg shadow-lg" />
    </div>
  </div>
</div>
```

### Responsive Grid Gallery

```html
<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4">
  <div class="aspect-square bg-gray-200 rounded-lg overflow-hidden">
    <img src="image1.jpg" class="w-full h-full object-cover hover:scale-105 transition" />
  </div>
  <div class="aspect-square bg-gray-200 rounded-lg overflow-hidden">
    <img src="image2.jpg" class="w-full h-full object-cover hover:scale-105 transition" />
  </div>
  <!-- More items... -->
</div>
```

## Animations & Transitions

### Basic Transitions

```html
<button class="bg-blue-500 hover:bg-blue-700 transition duration-300">
  Smooth transition
</button>
```

### Transform Effects

```html
<div class="transform hover:scale-110 transition duration-300">
  Scale on hover
</div>

<img class="transform hover:rotate-6 transition duration-300" />
```

### Built-in Animations

```html
<div class="animate-spin">Spinning</div>
<div class="animate-pulse">Pulsing</div>
<div class="animate-bounce">Bouncing</div>
```

## Performance Optimization

### Bundle Size Optimization

Configure content sources for optimal purging:

```javascript
// tailwind.config.js
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,vue,svelte}",
    "./node_modules/@mycompany/ui-lib/**/*.{js,ts,jsx,tsx}",
  ],
  // Enable JIT for faster builds
  jit: true,
}
```

### CSS Optimization Techniques

```html
<!-- Use content-visibility for offscreen content -->
<div class="content-visibility-auto">
  <div>Heavy content that's initially offscreen</div>
</div>

<!-- Optimize images with aspect-ratio -->
<img class="aspect-video w-full object-cover" src="video.jpg" alt="Video thumbnail" />

<!-- Use contain for paint optimization -->
<div class="contain-layout">
  Complex layout that doesn't affect outside elements
</div>
```

### Development Performance

```css
/* Enable CSS-first configuration in v4.1 */
@import "tailwindcss";

@theme {
  /* Define once, use everywhere */
  --color-brand: #3b82f6;
  --font-mono: "Fira Code", monospace;
}

/* Critical CSS for above-the-fold content */
@layer critical {
  .hero-title {
    @apply text-4xl md:text-6xl font-bold;
  }
}
```
