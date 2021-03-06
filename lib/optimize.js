'use strict';

/* global JuttleAdapterAPI */
let reducerDefaultValue = JuttleAdapterAPI.runtime.reducerDefaultValue;
let logger = JuttleAdapterAPI.getLogger('sql-optimize');

let _ = require('underscore');

const FETCH_SIZE_LIMIT = 10000;
const ALLOWED_REDUCE_OPTIONS = ['forget', 'groupby', 'every', 'on'];
const VALID_AGGREGATIONS = ['count', 'avg', 'sum', 'min', 'max', 'count_unique'];
const EMPTY_AGGREGATE_VALS = {
    avg: null,
    min: null,
    max: null,
    sum: null,
    count: 0,
    count_unique: 0
};

function _getFieldName(node) {
    return node.name;
}

function _getReducerName(node) {
    return node.callee.name;
}

function _expected_empty_reducer_result(expr) {
    return [_getFieldName(expr.left), reducerDefaultValue(_getReducerName(expr.right))];
}

function _empty_reducer_result(aggrs) {
    let empty_result = {};
    _.each(aggrs, function(val, target) {
        empty_result[target] = EMPTY_AGGREGATE_VALS[val.name || 'count_unique'];
    });
    return empty_result;
}

function _isReducerCall(node) {
    return (node.type === 'CallExpression' && node.context === 'reduce');
}

function reduce_expr_is_optimizable(expr) {
    if (expr.left.type !== 'Field') {
        logger.debug('optimization aborting -- unexpected reduce lhs:', expr.left);
        return false;
    }

    if (expr.left.name === 'time') {
        logger.debug('optimization aborting -- cannot optimize reduce on time');
        return false;
    }

    if (!_isReducerCall(expr.right)) {
        logger.debug('optimization aborting -- cannot optimize non-reducer-call node', expr.right);
        return false;
    }

    return true;
}

class Optimizer {
    static optimize_head(read, head, graph, optimization_info) {
        if (optimization_info.type && optimization_info.type !== 'head') {
            logger.debug('optimization aborting -- cannot append head optimization to prior',
                optimization_info.type, 'optimization');
            return false;
        }

        let limit = graph.node_get_option(head, 'arg');

        if (optimization_info.hasOwnProperty('limit')) {
            limit = Math.min(limit, optimization_info.limit);
        }

        optimization_info.type = 'head';
        optimization_info.limit = limit;
        return true;
    }

    static optimize_tail(read, tail, graph, optimization_info) {
        if (optimization_info.type && optimization_info.type !== 'tail') {
            logger.debug('optimization aborting -- cannot append tail optimization to prior',
                optimization_info.type, 'optimization');
            return false;
        }

        let limit = graph.node_get_option(tail, 'arg');
        if (optimization_info.hasOwnProperty('limit')) {
            limit = Math.min(limit, optimization_info.limit);
        }

        let fetchSize = graph.node_get_option(read, 'fetchSize') || FETCH_SIZE_LIMIT;
        if (fetchSize < limit) {
            // Doesn't make sense to reverse multiple pages of results in the adapter.
            logger.debug('optimization aborting -- fetchSize cannot be less than tail limit', {
                tail_limit: limit,
                fetchSize: fetchSize
            });
            return false;
        }

        optimization_info.type = 'tail';
        optimization_info.limit = limit;
        return true;
    }

    static optimize_reduce(read, reduce, graph, optimization_info) {
        if (!graph.node_contains_only_options(reduce, ALLOWED_REDUCE_OPTIONS)) {
            logger.warn('optimization aborting -- cannot optimize reduce with options', graph.node_get_option_names(reduce));
            return false;
        }
        if (optimization_info && optimization_info.type) {
            logger.debug('optimization aborting -- cannot append reduce optimization to prior', optimization_info.type, 'optimization');
            return false;
        }
        let groupby = graph.node_get_option(reduce, 'groupby');
        let grouped = groupby && groupby.length > 0;
        if (grouped && groupby.indexOf('time') !== -1) {
            logger.debug('optimization aborting -- cannot optimize group by time');
            return false;
        }

        let forget = graph.node_get_option(reduce, 'forget');
        if (forget === false) {
            logger.debug('optimization aborting -- cannot optimize -forget false');
            return false;
        }

        let aggrs = {},
            on,
            every;

        for (let i = 0; i < reduce.exprs.length; i++) { //make for-each for closure lets
            let expr = reduce.exprs[i];
            if (!reduce_expr_is_optimizable(expr)) {
                return false;
            }

            let target = _getFieldName(expr.left);
            let reducer = _getReducerName(expr.right);

            if (reducer === 'count' && expr.right.arguments.length === 0) {
                logger.debug('found simple count() reducer, optimizing');
                aggrs[target] = {
                    name: reducer,
                    field: '*'
                };
                continue;
            }

            if (expr.right.arguments.length !== 1) {
                logger.debug('optimization aborting -- cannot optimize any reducer with', expr.right.arguments.length, 'arguments');
                return false;
            }

            let argument_object = expr.right.arguments[0];
            if (argument_object.type !== 'StringLiteral') {
                logger.debug('optimization aborting -- found unexpected reducer argument:', JSON.stringify(argument_object));
                return false;
            }
            let arg = argument_object.value;

            if (!_.contains(VALID_AGGREGATIONS, reducer)) {
                logger.debug('optimization aborting -- unoptimizable reducer', JSON.stringify(reducer, null, 2));
                return false;
            }

            if (reducer === 'count_unique') {
                aggrs[target] = {
                    raw: 'COUNT(distinct ' + arg + ') as ' + target
                };
                continue;
            }

            aggrs[target] = {
                name: reducer,
                field: arg
            };
        }

        // expected by juttle
        let expect_empty_result = _.object(reduce.exprs.map(_expected_empty_reducer_result));

        // Actual empty point match returned from optimized query:
        //      currently the only difference is that actual empty sum is null while expected 0.
        let empty_result = _empty_reducer_result(aggrs);

        if (graph.node_has_option(reduce, 'every')) {
            every = graph.node_get_option(reduce, 'every');
            on = graph.node_get_option(reduce, 'on');
            if (every.is_calendar()) {
                logger.debug('optimization aborting -- cannot optimize calendar -every');
                return false;
            }
            if (_.intersection(graph.node_get_option_names(read), ['to', 'from']).length < 2) {
                logger.debug('optimization aborting -- cannot reduce -every without -from and -to options');
                return false;
            }
        }

        _.extend(optimization_info, {
            type: 'reduce',
            aggregations: aggrs,
            groupby: groupby,
            reduce_every: every,
            reduce_on: on,
            empty_aggregate: empty_result,
            expect_empty_aggregate: expect_empty_result
        });

        logger.debug('optimization succeeded', JSON.stringify(optimization_info, null, 2));

        return true;
    }
}

module.exports = Optimizer;
