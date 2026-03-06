<script lang="ts">
  import ResetPassword from '$components/auth/ResetPassword.svelte';
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card w-full max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl justify-center mb-2">Reset Password</h2>
      <ResetPassword />
      <a href="/auth/login" class="link link-primary text-sm text-center mt-4">
        Back to Sign In
      </a>
    </div>
  </div>
</div>
