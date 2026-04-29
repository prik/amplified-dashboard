import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://ampsrev.xyz/',
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
  ]
}
