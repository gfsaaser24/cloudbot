"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { memo, Suspense } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../components/form";
import { Input } from "../components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip";
import { useSharedTranslations } from "../contexts/shared-translations-context";
import { signUp } from "../lib/auth-client";
import { publicApiFetcher } from "../lib/fetcher";
import {
  signUpFormSchema,
  type SignUpFormData,
} from "../schemas/sign-up-form-schema";
import { CentralLoadingScreen } from "./central-loading-screen";
import { SubmitButton } from "./submit-button";

// Sign-up is invite-only: the form is only shown for a valid `?invite=` link.
// The server checks the invite again on sign-up; this check only decides what to show.
export const SignUp = memo(() => (
  <Suspense fallback={<CentralLoadingScreen />}>
    <InviteGate />
  </Suspense>
));

function InviteGate() {
  const { sharedT } = useSharedTranslations();
  const inviteToken = useSearchParams().get("invite");

  const { data, isPending } = useQuery({
    queryKey: ["invite", inviteToken],
    queryFn: () =>
      publicApiFetcher(
        (client) =>
          client.invites.verify.$post({ json: { token: inviteToken ?? "" } }),
        sharedT.apiCodes,
      ),
    enabled: !!inviteToken,
    retry: false,
  });

  if (!inviteToken) {
    return <InviteOnlyNotice text={sharedT.signUp.inviteOnly} />;
  }
  if (isPending) {
    return <CentralLoadingScreen />;
  }
  if (!data) {
    return <InviteOnlyNotice text={sharedT.signUp.inviteInvalid} />;
  }
  return <SignUpForm email={data.email} inviteToken={inviteToken} />;
}

function InviteOnlyNotice({ text }: { text: string }) {
  const { locale, sharedT } = useSharedTranslations();

  return (
    <div className="flex w-full flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">{sharedT.signUp.title}</h1>
        <p className="text-muted-foreground mt-2 text-sm">{text}</p>
      </div>
      <p className="text-sm">
        {sharedT.signUp.alreadyHaveAccount}{" "}
        <Link
          className="underline underline-offset-4"
          href={`/${locale}/sign-in`}
        >
          {sharedT.signUp.signInText}
        </Link>
      </p>
    </div>
  );
}

function SignUpForm({
  email,
  inviteToken,
}: {
  email: string;
  inviteToken: string;
}) {
  const { locale, sharedT } = useSharedTranslations();
  const router = useRouter();

  const form = useForm<SignUpFormData>({
    resolver: zodResolver(signUpFormSchema),
    defaultValues: {
      email,
      password: "",
      confirmPassword: "",
      name: "",
      username: "",
    },
  });

  async function onSubmit(values: SignUpFormData) {
    const signUpPromise = signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
      username: values.username,
      callbackURL: `${window.location.origin}/${locale}`,
      fetchOptions: {
        // Checked by the better-auth before hook on the server (packages/server/src/auth-server.ts).
        headers: { "x-invite-token": inviteToken },
        onError: (ctx) => {
          throw new Error(ctx.error.message);
        },
        onSuccess: async () => {
          router.push(`/${locale}/sign-in`);
        },
      },
    });

    toast.promise(signUpPromise, {
      loading: sharedT.signUp.signingUp,
      success: sharedT.signUp.success,
      error: (error) => error.message || sharedT.signUp.error,
    });
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="grid gap-6">
        <div>
          <h1 className="text-2xl font-medium">{sharedT.signUp.title}</h1>
          <p className="text-sm">
            {sharedT.signUp.alreadyHaveAccount}{" "}
            <Link
              className="underline underline-offset-4"
              href={`/${locale}/sign-in`}
            >
              {sharedT.signUp.signInText}
            </Link>
          </p>
        </div>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex w-full flex-col"
          >
            <div className="flex flex-col gap-5 [&>input]:mb-3">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{sharedT.signIn.emailLabel}</FormLabel>
                    <FormControl>
                      <Input
                        readOnly
                        className="bg-muted text-muted-foreground"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{sharedT.signIn.passwordLabel}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={sharedT.signIn.passwordPlaceholder}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{sharedT.signUp.confirmPasswordLabel}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={sharedT.signUp.confirmPasswordPlaceholder}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel htmlFor="name">
                        {sharedT.profileForm.name}
                      </FormLabel>
                      <div className="hidden items-center space-x-1 md:flex">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="text-primary size-4" />
                            </TooltipTrigger>
                            <TooltipContent>
                              {sharedT.profileForm.nameTooltip}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>
                    <FormControl>
                      <Input placeholder="John Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel htmlFor="username">
                        {sharedT.profileForm.username}
                      </FormLabel>
                    </div>
                    <FormControl>
                      <Input placeholder="johndoe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <SubmitButton
                className="w-full"
                isPending={form.formState.isSubmitting}
                pendingText={sharedT.signUp.signingUp}
              >
                {sharedT.signUp.signUpButton}
              </SubmitButton>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
