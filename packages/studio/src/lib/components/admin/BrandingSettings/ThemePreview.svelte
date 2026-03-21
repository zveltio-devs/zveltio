<script lang="ts">
import { Check, AlertCircle, Info, Mail, Star, Zap } from '@lucide/svelte';

 interface Props {
 primaryColor: string;
 secondaryColor: string;
 accentColor: string;
 fontFamily: string;
 logoUrl?: string | null;
 companyName?: string;
 }

 let {
 primaryColor, secondaryColor, accentColor,
 fontFamily, logoUrl, companyName = 'Company',
 }: Props = $props();
</script>

<div class="card bg-base-100 shadow-xl" style="font-family: '{fontFamily}', sans-serif">
 <div class="card-body">
 <h2 class="card-title mb-4">🎨 Live Preview</h2>
 <div class="space-y-4">
 <div class="text-center p-4 rounded-lg" style="background: linear-gradient(135deg, {primaryColor}, {secondaryColor});">
 {#if logoUrl}
 <img src={logoUrl} alt={companyName} class="h-12 mx-auto mb-2 bg-white/20 rounded p-1" />
 {:else}
 <span class="text-3xl font-bold text-white">{companyName}</span>
 {/if}
 </div>

 <div class="flex gap-2 flex-wrap">
 <button class="btn" style="background-color: {primaryColor}; border-color: {primaryColor}; color: white;">Primary Button</button>
 <button class="btn" style="background-color: {secondaryColor}; border-color: {secondaryColor}; color: white;">Secondary Button</button>
 <button class="btn" style="background-color: {accentColor}; border-color: {accentColor}; color: white;">Accent Button</button>
 </div>

 <div class="flex gap-2 flex-wrap">
 <div class="badge" style="background-color: {primaryColor}; color: white; border: none;">Primary</div>
 <div class="badge" style="background-color: {secondaryColor}; color: white; border: none;">Secondary</div>
 <div class="badge" style="background-color: {accentColor}; color: white; border: none;">Accent</div>
 <div class="badge badge-outline" style="border-color: {primaryColor}; color: {primaryColor};">Outlined</div>
 </div>

 <div class="alert" style="background-color: {primaryColor}20; border-color: {primaryColor};">
 <Check size={20} style="color: {primaryColor};" />
 <span>Success alert with primary color</span>
 </div>

 <div class="alert bg-base-200"><Info size={20} /><span>Info alert with default styling</span></div>

 <div class="stat bg-base-200 rounded-box" style="border-left: 4px solid {primaryColor};">
 <div class="stat-title">Total Records</div>
 <div class="stat-value" style="color: {primaryColor};">1,234</div>
 <div class="stat-desc">↗︎ 12% from last month</div>
 </div>

 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th style="color: {primaryColor};">Name</th>
 <th style="color: {primaryColor};">Status</th>
 <th style="color: {primaryColor};">Role</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 <td>John Doe</td>
 <td><span class="badge badge-sm" style="background-color: {primaryColor}; color: white; border: none;">Active</span></td>
 <td>Admin</td>
 </tr>
 <tr>
 <td>Jane Smith</td>
 <td><span class="badge badge-sm" style="background-color: {accentColor}; color: white; border: none;">Pending</span></td>
 <td>User</td>
 </tr>
 </tbody>
 </table>
 </div>

 <div class="flex gap-4 items-center justify-center py-2">
 <Mail size={24} style="color: {primaryColor};" />
 <Star size={24} style="color: {accentColor};" />
 <Zap size={24} style="color: {secondaryColor};" />
 <Check size={24} style="color: {primaryColor};" />
 </div>
 </div>

 <div class="divider"></div>
 <p class="text-sm opacity-70">Preview shows how your theme will look across the application</p>
 </div>
</div>
