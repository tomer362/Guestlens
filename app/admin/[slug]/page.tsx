import { Admin } from "@/components/admin/Admin";
export const metadata = { title: "Admin · GuestLens", robots: { index: false } };
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <Admin slug={(await params).slug} />;
}
