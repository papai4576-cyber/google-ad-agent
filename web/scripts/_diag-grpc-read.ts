import { GoogleAdsApi } from "google-ads-api";

async function main() {
  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
  });
  const customer = client.Customer({
    customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID!,
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
  });
  try {
    const rows = await customer.query("SELECT campaign.id FROM campaign LIMIT 1");
    console.log("GRPC QUERY OK:", JSON.stringify(rows));
  } catch (e) {
    console.error("GRPC QUERY FAILED:", String((e as Error)?.message || e).slice(0, 300));
    process.exitCode = 1;
  }
}
main();
