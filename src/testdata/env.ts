// Every test runs against ether's config, the one the prompt snapshot was taken with.
process.env.REVIEW_CONFIG = `${import.meta.dir}/ether.json`;
