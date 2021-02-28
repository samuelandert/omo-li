import {QueryProfilesArgs, RequireFields} from "../../types";
import {PrismaClient} from "@prisma/client";

export function whereProfile(args: RequireFields<QueryProfilesArgs, never>) {
    const q: { [key: string]: any } = {};
    if (!args.query) {
        throw new Error(`No query fields have been specified`);
    }
    Object.keys(args.query ?? {})
        .map(key => {
            return {
                key: key,
                // @ts-ignore
                value: args.query[key]
            }
        })
        .filter(kv => kv.value)
        .forEach(kv => {
            q[kv.key] = kv.value;
        });

    if (Object.keys(q).length === 0) {
        throw new Error(`At least one query field must be specified.`);
    }
    return q;
}

export function profilesResolver(prisma:PrismaClient) {
    return async (parent:any, args:QueryProfilesArgs) => {
        const q = whereProfile(args);
        return await prisma.profile.findMany({
            where: {
                ...q
            }
        });
    };
}